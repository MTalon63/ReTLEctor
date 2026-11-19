import config from "./config";
import log from "./logger";
import { serialize } from "./upstream";
import type { OmmRecord } from "./omm";

let session: string | null = null;
let sessionAt = 0;
let lastRequestAt = 0;
const requestLog: number[] = [];

const SESSION_TTL_MS = 50 * 60 * 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isConfigured(): boolean {
	return Boolean(config.spacetrackUser && config.spacetrackPassword);
}

// One queue, spaced and capped under Space-Track's 30/min and 300/hour.
async function awaitSlot(): Promise<void> {
	for (;;) {
		const now = Date.now();
		while (requestLog.length && now - requestLog[0]! > 60 * 60 * 1000) requestLog.shift();

		const inMinute = requestLog.filter((t) => now - t < 60 * 1000);
		if (inMinute.length >= config.spacetrackMaxPerMinute) {
			await sleep(60 * 1000 - (now - inMinute[0]!) + 100);
			continue;
		}
		if (requestLog.length >= config.spacetrackMaxPerHour) {
			await sleep(60 * 1000 - (now - requestLog[0]!) + 100);
			continue;
		}

		const wait = lastRequestAt + config.spacetrackMinSpacingMs - now;
		if (wait > 0) await sleep(wait);
		break;
	}

	lastRequestAt = Date.now();
	requestLog.push(lastRequestAt);
}

async function login(): Promise<string> {
	const response = await fetch(`${config.spacetrackUrl}/ajaxauth/login`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ identity: config.spacetrackUser!, password: config.spacetrackPassword! }).toString(),
		signal: AbortSignal.timeout(config.upstreamTimeoutMs),
	});

	if (!response.ok) throw new Error(`Space-Track login failed: HTTP ${response.status}`);

	const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
	const cookie = cookies.map((c) => c.split(";")[0]).join("; ") || response.headers.get("set-cookie")?.split(";")[0] || "";
	if (!cookie) throw new Error("Space-Track login returned no session cookie");

	session = cookie;
	sessionAt = Date.now();
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

function toRecord(raw: Record<string, string>): OmmRecord {
	const num = (key: string) => {
		const value = parseFloat(raw[key] ?? "");
		return Number.isFinite(value) ? value : 0;
	};

	return {
		OBJECT_NAME: raw.OBJECT_NAME ?? "",
		OBJECT_ID: raw.OBJECT_ID ?? "",
		EPOCH: raw.EPOCH ?? "",
		MEAN_MOTION: num("MEAN_MOTION"),
		ECCENTRICITY: num("ECCENTRICITY"),
		INCLINATION: num("INCLINATION"),
		RA_OF_ASC_NODE: num("RA_OF_ASC_NODE"),
		ARG_OF_PERICENTER: num("ARG_OF_PERICENTER"),
		MEAN_ANOMALY: num("MEAN_ANOMALY"),
		EPHEMERIS_TYPE: num("EPHEMERIS_TYPE"),
		CLASSIFICATION_TYPE: raw.CLASSIFICATION_TYPE || "U",
		NORAD_CAT_ID: num("NORAD_CAT_ID"),
		ELEMENT_SET_NO: num("ELEMENT_SET_NO"),
		REV_AT_EPOCH: num("REV_AT_EPOCH"),
		BSTAR: num("BSTAR"),
		MEAN_MOTION_DOT: num("MEAN_MOTION_DOT"),
		MEAN_MOTION_DDOT: num("MEAN_MOTION_DDOT"),
	};
}

// They keep serving the last element set of dropped objects; a stale epoch means no current data.
function epochAgeDays(record: OmmRecord): number | undefined {
	const epoch = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(record.EPOCH) ? record.EPOCH : `${record.EPOCH}Z`);

	return Number.isFinite(epoch) ? (Date.now() - epoch) / 86_400_000 : undefined;
}

export function spaceTrackEnabled(): boolean {
	return isConfigured();
}

export async function fetchGpByNoradId(noradId: number): Promise<OmmRecord | null> {
	if (!isConfigured()) return null;

	return serialize(async () => {
		await awaitSlot();

		const response = await query(`/basicspacedata/query/class/gp/NORAD_CAT_ID/${noradId}/format/json`);
		if (!response.ok) throw new Error(`Space-Track query failed for NORAD ID ${noradId}: HTTP ${response.status}`);

		const payload = (await response.json()) as Record<string, string>[];
		if (!Array.isArray(payload) || payload.length === 0) return null;

		const record = toRecord(payload[0]!);
		const ageDays = epochAgeDays(record);
		if (ageDays !== undefined && config.spacetrackMaxAgeDays > 0 && ageDays > config.spacetrackMaxAgeDays) {
			log.info(
				`Space-Track GP for NORAD ID ${noradId} (${record.OBJECT_NAME}) is ${ageDays.toFixed(0)} days old (epoch ${record.EPOCH}); treating as no data.`,
			);
			return null;
		}

		return record;
	});
}

export function resetSpaceTrackSession(): void {
	session = null;
	sessionAt = 0;
	lastRequestAt = 0;
	requestLog.length = 0;
}
