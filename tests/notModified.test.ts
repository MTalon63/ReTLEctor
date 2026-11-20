import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import kv from "../src/utils/kv";
import config from "../src/utils/config";
import { resetUpstreamState } from "../src/utils/upstream";
import { clearCelestrakFailures, isCelestrakLockedOut } from "../src/utils/lockout";
import fetchTle from "../src/utils/tleFetcher";

const CSV = `OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE,ARG_OF_PERICENTER,MEAN_ANOMALY,EPHEMERIS_TYPE,CLASSIFICATION_TYPE,NORAD_CAT_ID,ELEMENT_SET_NO,REV_AT_EPOCH,BSTAR,MEAN_MOTION_DOT,MEAN_MOTION_DDOT
ISS (ZARYA),1998-067A,2026-11-19T06:28:00.055776,15.49482233,.00074107,51.6317,252.6441,42.3196,317.8363,0,U,25544,999,59579,.25566563E-3,.13909E-3,0
`;

// The exact wording Celestrak uses when the caller already has current data.
const NOTICE = `GP data has not updated since your last successful request. Data is updated once every 2 hours.`;

const originalFetch = globalThis.fetch;
const originalSpacing = config.upstreamMinSpacingMs;

beforeEach(async () => {
	resetUpstreamState();
	await clearCelestrakFailures();
	config.upstreamMinSpacingMs = 0;
	await kv.set("stations_csv", CSV);
	await kv.set("stations_timestamp_csv", Date.now() - 5 * 60 * 60 * 1000);
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	config.upstreamMinSpacingMs = originalSpacing;
	await clearCelestrakFailures();
});

describe("not-modified notice", () => {
	test("a 403 not-modified response is not treated as a block", async () => {
		globalThis.fetch = (async () => new Response(NOTICE, { status: 403 })) as unknown as typeof fetch;

		const body = await fetchTle("stations", "csv");

		expect(body).toContain("ISS (ZARYA)");
		expect((await isCelestrakLockedOut()).locked).toBe(false);
	});

	test("it refreshes the cache timestamp so the data counts as current", async () => {
		globalThis.fetch = (async () => new Response(NOTICE, { status: 403 })) as unknown as typeof fetch;

		await fetchTle("stations", "csv");

		const timestamp = (await kv.get("stations_timestamp_csv")) as number;
		expect(timestamp).toBeGreaterThan(Date.now() - 60_000);
	});

	test("a 429 not-modified response is not treated as a block either", async () => {
		globalThis.fetch = (async () => new Response(NOTICE, { status: 429 })) as unknown as typeof fetch;

		await fetchTle("stations", "csv");

		expect((await isCelestrakLockedOut()).locked).toBe(false);
	});

	test("a policy 403 still locks out", async () => {
		globalThis.fetch = (async () => new Response("403 Forbidden: excessive requests", { status: 403 })) as unknown as typeof fetch;

		const body = await fetchTle("stations", "csv");

		expect(body).toContain("ISS (ZARYA)");
		expect((await isCelestrakLockedOut()).locked).toBe(true);
	});
});
