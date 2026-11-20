import kv from "./kv";
import log from "./logger";
import config from "./config";
import fetchTle from "./tleFetcher";
import { coalesce } from "./upstream";
import { fetchGpByNoradId, gpIndexSize, spaceTrackEnabled } from "./spacetrack";
import { decode as decodeAlpha5 } from "./alpha5";
import { parseOmmCsv, csvTo3le, csvToJson, csvToKvn, recordsToCsv, type OmmRecord } from "./omm";

export type OrbitFormat = "tle" | "json" | "csv" | "kvn";

export function normalizeOrbitFormat(rawFormat?: string): OrbitFormat {
	if (!rawFormat) return "csv";
	const lower = rawFormat.toLowerCase().split(".")[0]?.trim();
	if (lower === "3le" || lower === "tle") return "tle";
	if (lower === "json") return "json";
	if (lower === "kvn") return "kvn";
	return "csv";
}

export function isValidOrbitFormat(rawFormat?: string): boolean {
	if (!rawFormat) return true;
	const lower = rawFormat.toLowerCase().split(".")[0]?.trim();
	return lower === "csv" || lower === "json" || lower === "tle" || lower === "3le" || lower === "kvn";
}

export interface NoradResult {
	data: string;
	contentType: string;
	timestamp: number;
	modified: number;
}

// Element epoch, not the cache stamp — that is what a consumer tracks.
function elementEpochMs(csv: string): number | undefined {
	const epoch = parseOmmCsv(csv)[0]?.EPOCH;
	if (!epoch) return undefined;

	const ms = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(epoch) ? epoch : `${epoch}Z`);

	return Number.isFinite(ms) ? ms : undefined;
}

function notFound(noradId: number): Error {
	const err = new Error(`No orbital data found for NORAD ID ${noradId}`);
	(err as any).statusCode = 404;
	return err;
}

async function markMissing(noradId: number): Promise<void> {
	await kv.set(`norad_${noradId}_missing`, Date.now() + config.cacheNotFoundDuration, config.cacheNotFoundDuration);
}

export function getNoradCsv(noradId: number): Promise<{ csv: string; record?: OmmRecord; timestamp: number }> {
	return coalesce(`norad:${noradId}`, () => getNoradCsvUncoalesced(noradId));
}

let activeIndex: { stamp: number; byId: Map<number, OmmRecord> } | null = null;

// Parse the 2.5 MB active group once per refresh, not per request.
function extractFromActive(activeCsv: string, stamp: number | undefined, noradId: number): OmmRecord | undefined {
	if (!activeIndex || activeIndex.stamp !== (stamp ?? 0)) {
		const byId = new Map<number, OmmRecord>();
		for (const record of parseOmmCsv(activeCsv)) byId.set(record.NORAD_CAT_ID, record);
		activeIndex = { stamp: stamp ?? 0, byId };
	}

	return activeIndex.byId.get(noradId);
}

// Catalog numbers come from the cached "active" group or Space-Track, never from a Celestrak CATNR query.
async function getNoradCsvUncoalesced(noradId: number): Promise<{ csv: string; record?: OmmRecord; timestamp: number }> {
	const missingUntil = (await kv.get(`norad_${noradId}_missing`)) as number | null;
	if (missingUntil && Date.now() < missingUntil) throw notFound(noradId);

	const cachedCsv = (await kv.get(`norad_${noradId}_csv`)) as string | null;
	const timestamp = (await kv.get(`norad_${noradId}_timestamp`)) as number | undefined;
	const now = Date.now();

	if (cachedCsv && timestamp && now - timestamp <= config.cacheNoradDuration) {
		return { csv: cachedCsv, timestamp };
	}

	let activeCsv = (await kv.get("active_csv")) as string | null;
	const activeTimestamp = (await kv.get("active_timestamp_csv")) as number | undefined;
	const activeIsStale = activeTimestamp ? now - activeTimestamp > config.cacheActiveDuration : true;

	if (!activeCsv || activeIsStale) {
		try {
			await fetchTle("active", "csv");
		} catch (err) {
			log.warn(`Failed to refresh the active GP group for NORAD ID ${noradId}: ${err}`);
		}
		activeCsv = (await kv.get("active_csv")) as string | null;
	}

	if (activeCsv) {
		const found = extractFromActive(activeCsv, activeTimestamp, noradId);
		if (found) {
			const singleCsv = recordsToCsv([found]);
			await kv.set(`norad_${noradId}_csv`, singleCsv);
			await kv.set(`norad_${noradId}_timestamp`, now);

			return { csv: singleCsv, record: found, timestamp: now };
		}
	}

	const indexReady = spaceTrackEnabled() && (await gpIndexSize()) > 0;

	if (indexReady) {
		try {
			const record = await fetchGpByNoradId(noradId);
			if (record) {
				const cleanCsv = recordsToCsv([record]);
				await kv.set(`norad_${noradId}_csv`, cleanCsv);
				await kv.set(`norad_${noradId}_timestamp`, Date.now());

				return { csv: cleanCsv, record, timestamp: Date.now() };
			}
		} catch (err) {
			log.warn(`Space-Track lookup failed for NORAD ID ${noradId}: ${err}`);
			if (cachedCsv) return { csv: cachedCsv, timestamp: timestamp ?? now };
			throw err;
		}
	}

	// Only a populated index proves the object is absent; without one, don't poison the cache.
	if (indexReady) await markMissing(noradId);

	if (cachedCsv) return { csv: cachedCsv, timestamp: timestamp ?? now };

	throw notFound(noradId);
}

export async function getNoradData(noradId: number, format: OrbitFormat): Promise<NoradResult> {
	const { csv, timestamp } = await getNoradCsv(noradId);
	const modified = elementEpochMs(csv) ?? timestamp;

	if (format === "json") {
		return {
			data: csvToJson(csv),
			contentType: "application/json",
			timestamp,
			modified,
		};
	}

	if (format === "kvn") {
		return {
			data: csvToKvn(csv),
			contentType: "text/plain",
			timestamp,
			modified,
		};
	}

	if (format === "csv") {
		return {
			data: csv,
			contentType: "text/plain",
			timestamp,
			modified,
		};
	}

	return {
		data: csvTo3le(csv),
		contentType: "text/plain",
		timestamp,
		modified,
	};
}

export async function handleNoradRequest(idParam: string, format: OrbitFormat): Promise<Response> {
	const cleanId = idParam.split(".")[0]?.trim() || "";
	let noradId: number;
	try {
		noradId = decodeAlpha5(cleanId.toUpperCase());
	} catch {
		return new Response("Invalid NORAD ID.", { status: 400 });
	}
	if (isNaN(noradId) || noradId <= 0) {
		return new Response("Invalid NORAD ID.", { status: 400 });
	}

	try {
		const { data, contentType, timestamp, modified } = await getNoradData(noradId, format);
		const age = Date.now() - timestamp;
		const maxAge = Math.max(0, Math.ceil((config.cacheNoradDuration - age) / 1000));

		return new Response(data, {
			status: 200,
			headers: {
				"Content-Type": contentType,
				"Cache-Control": `max-age=${maxAge}`,
				"Last-Modified": new Date(modified).toUTCString(),
			},
		});
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		if ((error as any)?.statusCode === 404 || msg.includes("No orbital data found") || msg.includes("No TLE data found")) {
			return new Response(`No orbital data found for NORAD ID ${noradId}.`, {
				status: 404,
				headers: { "Content-Type": "text/plain" },
			});
		}

		log.error({ err: error }, `Failed to serve NORAD ID ${noradId} (format: ${format})`);

		return new Response("Failed to retrieve orbital data. Upstream may be unavailable.", {
			status: 503,
			headers: { "Content-Type": "text/plain" },
		});
	}
}

async function getObjectsTle(noradId: number): Promise<string> {
	const res = await getNoradData(noradId, "tle");
	return res.data;
}

export default getObjectsTle;
