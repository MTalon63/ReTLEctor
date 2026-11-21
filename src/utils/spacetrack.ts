import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import config from "./config";
import log from "./logger";
import { parseOmmCsv, recordsToCsv, type OmmRecord } from "./omm";

// Space-Track allows one GP query per hour: fetch in bulk, keep locally, answer from the index.
const DEFAULT_GP_PATH = "/basicspacedata/query/class/gp/decay_date/null-val/CREATION_DATE/%3Enow-0.042/format/csv";
const REFRESH_GAP_MS = 30 * 60 * 1000;
const SESSION_TTL_MS = 50 * 60 * 1000;

let session: string | null = null;
let sessionAt = 0;
let loginSuspendedUntil = 0;
let loginFailures = 0;

let gpIndex = new Map<number, OmmRecord>();
let gpIndexAt = 0;
let indexLoaded = false;
let refreshing: Promise<number> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function isConfigured(): boolean {
	return Boolean(config.spacetrackUser && config.spacetrackPassword);
}

function epochMs(record: OmmRecord): number {
	const epoch = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(record.EPOCH) ? record.EPOCH : `${record.EPOCH}Z`);

	return Number.isFinite(epoch) ? epoch : 0;
}

// They keep serving the last element set of dropped objects; a stale epoch means no current data.
function isStale(record: OmmRecord): boolean {
	if (config.spacetrackMaxAgeDays <= 0) return false;

	const epoch = epochMs(record);
	if (epoch === 0) return false;

	return (Date.now() - epoch) / 86_400_000 > config.spacetrackMaxAgeDays;
}

async function login(): Promise<string> {
	const suspended = loginSuspendedUntil - Date.now();
	if (suspended > 0) {
		throw new Error(
			`Space-Track logins suspended for another ${Math.ceil(suspended / 60_000)}m; check SPACETRACK_USER / SPACETRACK_PASS`,
		);
	}

	const response = await fetch(`${config.spacetrackUrl}/ajaxauth/login`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": config.userAgent },
		body: new URLSearchParams({ identity: config.spacetrackUser!, password: config.spacetrackPassword! }).toString(),
		signal: AbortSignal.timeout(config.upstreamTimeoutMs),
	});

	const body = (await response.text()).trim();

	// A rejected login is HTTP 200 with {"Login":"Failed"}, so the status proves nothing.
	if (!response.ok || /"Login"\s*:\s*"Failed"/i.test(body)) {
		loginFailures++;
		const pauseMs = Math.min(config.spacetrackLoginCooldownMs * 2 ** (loginFailures - 1), 60 * 60 * 1000);
		loginSuspendedUntil = Date.now() + pauseMs;
		const reason = body || `HTTP ${response.status}`;
		log.error(
			`Space-Track rejected the login (${reason}); pausing logins for ${Math.round(pauseMs / 60_000)}m. Check SPACETRACK_USER / SPACETRACK_PASS.`,
		);
		throw new Error(`Space-Track login rejected: ${reason}`);
	}

	const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
	const cookie = cookies.map((c) => c.split(";")[0]).join("; ") || response.headers.get("set-cookie")?.split(";")[0] || "";
	if (!cookie) throw new Error("Space-Track login returned no session cookie");

	session = cookie;
	sessionAt = Date.now();
	loginFailures = 0;
	log.info("Space-Track session established.");

	return cookie;
}

async function query(path: string): Promise<Response> {
	let cookie = session && Date.now() - sessionAt < SESSION_TTL_MS ? session : await login();

	let response = await fetch(`${config.spacetrackUrl}${path}`, {
		headers: { Cookie: cookie, "User-Agent": config.userAgent },
		signal: AbortSignal.timeout(config.upstreamTimeoutMs),
	});

	if (response.status === 401 || response.status === 403) {
		cookie = await login();
		response = await fetch(`${config.spacetrackUrl}${path}`, {
			headers: { Cookie: cookie, "User-Agent": config.userAgent },
			signal: AbortSignal.timeout(config.upstreamTimeoutMs),
		});
	}

	return response;
}

async function loadIndex(): Promise<void> {
	if (indexLoaded) return;
	indexLoaded = true;

	try {
		const csv = await readFile(config.gpIndexFile, "utf8");
		for (const record of parseOmmCsv(csv)) gpIndex.set(record.NORAD_CAT_ID, record);
		log.info(`Loaded ${gpIndex.size} cached GP record(s) from ${config.gpIndexFile}.`);
	} catch {
		gpIndexAt = 0;
	}
}

export function spaceTrackEnabled(): boolean {
	return isConfigured();
}

export async function gpIndexSize(): Promise<number> {
	if (!isConfigured()) return 0;
	await loadIndex();

	return gpIndex.size;
}

export async function refreshGpIndex(force = false): Promise<number> {
	if (!isConfigured()) return 0;
	await loadIndex();

	if (!force && Date.now() - gpIndexAt < REFRESH_GAP_MS) return 0;
	if (refreshing) return refreshing;

	refreshing = (async () => {
		const response = await query(config.spacetrackGpPath || DEFAULT_GP_PATH);
		if (!response.ok) throw new Error(`Space-Track GP refresh failed: HTTP ${response.status}`);

		const fetched = parseOmmCsv(await response.text());
		let added = 0;

		for (const record of fetched) {
			const existing = gpIndex.get(record.NORAD_CAT_ID);
			if (!existing) added++;
			if (!existing || epochMs(record) >= epochMs(existing)) gpIndex.set(record.NORAD_CAT_ID, record);
		}

		gpIndexAt = Date.now();
		await mkdir(dirname(config.gpIndexFile), { recursive: true });
		await writeFile(config.gpIndexFile, recordsToCsv([...gpIndex.values()]), "utf8");
		log.info(`Space-Track GP refresh: ${fetched.length} record(s) received, ${added} new, ${gpIndex.size} held.`);

		return fetched.length;
	})();

	try {
		return await refreshing;
	} finally {
		refreshing = null;
	}
}

export async function fetchGpByNoradId(noradId: number): Promise<OmmRecord | null> {
	if (!isConfigured()) return null;
	await loadIndex();

	const record = gpIndex.get(noradId);
	if (!record) return null;

	if (isStale(record)) {
		log.info(`Cached Space-Track GP for NORAD ID ${noradId} (${record.OBJECT_NAME}) is too old (epoch ${record.EPOCH}); no data.`);
		return null;
	}

	return record;
}

function msUntilNextSlot(): number {
	const now = new Date();
	const target = new Date(now);
	target.setUTCMinutes(config.spacetrackGpMinute, 0, 0);
	if (target <= now) target.setUTCHours(target.getUTCHours() + 1);

	return target.getTime() - now.getTime() + Math.floor(Math.random() * 60_000);
}

export function startGpRefresh(): void {
	if (!isConfigured() || timer) return;

	const tick = () => {
		refreshGpIndex(true).catch((err) => log.error(`Scheduled Space-Track GP refresh failed: ${err}`));
		timer = setTimeout(tick, 60 * 60 * 1000);
	};

	timer = setTimeout(tick, msUntilNextSlot());
	log.info(`Space-Track GP refresh scheduled at :${String(config.spacetrackGpMinute).padStart(2, "0")} UTC every hour.`);

	if (Date.now() - gpIndexAt > 60 * 60 * 1000) {
		refreshGpIndex(true).catch((err) => log.error(`Initial Space-Track GP refresh failed: ${err}`));
	}
}

export function resetSpaceTrackSession(): void {
	session = null;
	sessionAt = 0;
	loginSuspendedUntil = 0;
	loginFailures = 0;
	gpIndex = new Map<number, OmmRecord>();
	gpIndexAt = 0;
	indexLoaded = false;
	refreshing = null;

	if (timer) {
		clearTimeout(timer);
		timer = null;
	}
}
