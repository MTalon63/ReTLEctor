import { afterEach, describe, expect, test } from "bun:test";
import kv from "../src/utils/kv";
import config from "../src/utils/config";
import { resetUpstreamState } from "../src/utils/upstream";
import { getNoradData } from "../src/utils/tleGetter";
import { LOCKOUT_KEY, NOT_FOUND_STREAK_KEY } from "../src/utils/lockout";

const HEADER =
	"OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE,ARG_OF_PERICENTER,MEAN_ANOMALY,EPHEMERIS_TYPE,CLASSIFICATION_TYPE,NORAD_CAT_ID,ELEMENT_SET_NO,REV_AT_EPOCH,BSTAR,MEAN_MOTION_DOT,MEAN_MOTION_DDOT";

const ACTIVE_CSV = `${HEADER}
ISS (ZARYA),1998-067A,2026-11-19T06:28:00.055776,15.49482233,.00074107,51.6317,252.6441,42.3196,317.8363,0,U,25544,999,59579,.25566563E-3,.13909E-3,0
`;

const originalFetch = globalThis.fetch;
const originalBudget = config.celestrakMaxDirectRequests;
const originalSpacing = config.upstreamMinSpacingMs;

async function resetState(): Promise<void> {
	resetUpstreamState();
	await kv.delete("celestrakTries");
	await kv.delete("celestrakWindowStart");
	await kv.delete(LOCKOUT_KEY);
	await kv.delete(NOT_FOUND_STREAK_KEY);
	await kv.delete("active_csv");
	await kv.delete("active_timestamp_csv");
}

afterEach(async () => {
	globalThis.fetch = originalFetch;
	config.celestrakMaxDirectRequests = originalBudget;
	config.upstreamMinSpacingMs = originalSpacing;
	await resetState();
});

describe("direct-fetch budget", () => {
	test("concurrent misses cannot exceed the hourly cap", async () => {
		config.celestrakMaxDirectRequests = 5;
		config.upstreamMinSpacingMs = 0;
		await resetState();
		await kv.set("active_csv", ACTIVE_CSV);
		await kv.set("active_timestamp_csv", Date.now());

		let upstreamHits = 0;
		globalThis.fetch = (async (url: string | URL) => {
			if (String(url).includes("GROUP=active")) return new Response(ACTIVE_CSV, { status: 200 });
			upstreamHits++;
			return new Response("No GP data found", { status: 404 });
		}) as unknown as typeof fetch;

		const requests = Array.from({ length: 40 }, (_, i) => getNoradData(900000 + i, "csv"));
		const results = await Promise.allSettled(requests);

		expect(upstreamHits).toBeLessThanOrEqual(5);
		expect(results.filter((r) => r.status === "rejected").length).toBeGreaterThan(0);
	});

	test("the cap resets when the window rolls over", async () => {
		config.celestrakMaxDirectRequests = 1;
		config.upstreamMinSpacingMs = 0;
		await resetState();
		await kv.set("active_csv", ACTIVE_CSV);
		await kv.set("active_timestamp_csv", Date.now());

		let upstreamHits = 0;
		globalThis.fetch = (async (url: string | URL) => {
			if (String(url).includes("GROUP=active")) return new Response(ACTIVE_CSV, { status: 200 });
			upstreamHits++;
			return new Response("No GP data found", { status: 404 });
		}) as unknown as typeof fetch;

		await getNoradData(900001, "csv").catch(() => undefined);
		await getNoradData(900002, "csv").catch(() => undefined);
		expect(upstreamHits).toBe(1);

		await kv.set("celestrakWindowStart", Date.now() - 61 * 60 * 1000);
		await getNoradData(900003, "csv").catch(() => undefined);
		expect(upstreamHits).toBe(2);
	});
});
