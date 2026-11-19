import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import kv from "../src/utils/kv";
import config from "../src/utils/config";
import { resetUpstreamState } from "../src/utils/upstream";
import { resetSpaceTrackSession } from "../src/utils/spacetrack";
import { getNoradData, handleNoradRequest } from "../src/utils/tleGetter";

const HEADER =
	"OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE,ARG_OF_PERICENTER,MEAN_ANOMALY,EPHEMERIS_TYPE,CLASSIFICATION_TYPE,NORAD_CAT_ID,ELEMENT_SET_NO,REV_AT_EPOCH,BSTAR,MEAN_MOTION_DOT,MEAN_MOTION_DDOT";

const ACTIVE_CSV = `${HEADER}
ISS (ZARYA),1998-067A,2026-11-19T06:28:00.055776,15.49482233,.00074107,51.6317,252.6441,42.3196,317.8363,0,U,25544,999,59579,.25566563E-3,.13909E-3,0
`;

const originalFetch = globalThis.fetch;
const originalUser = config.spacetrackUser;
const originalPass = config.spacetrackPassword;
const originalSpacing = config.upstreamMinSpacingMs;

let upstreamCalls: string[] = [];
let runBase = 0;

beforeEach(async () => {
	resetUpstreamState();
	resetSpaceTrackSession();
	config.spacetrackUser = null;
	config.spacetrackPassword = null;
	config.upstreamMinSpacingMs = 0;
	upstreamCalls = [];
	runBase = 1_000_000 + Math.floor(Math.random() * 500_000);

	globalThis.fetch = (async (input: string | URL) => {
		const url = String(input);
		upstreamCalls.push(url);
		if (url.includes("GROUP=active")) return new Response(ACTIVE_CSV, { status: 200 });
		return new Response("unexpected upstream call", { status: 500 });
	}) as unknown as typeof fetch;

	await kv.delete("active_csv");
	await kv.delete("active_timestamp_csv");
	await kv.delete("norad_25544_csv");
	await kv.delete("norad_25544_timestamp");
	await kv.delete("norad_25544_missing");
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	config.spacetrackUser = originalUser;
	config.spacetrackPassword = originalPass;
	config.upstreamMinSpacingMs = originalSpacing;
	resetSpaceTrackSession();
});

async function warmActive(): Promise<void> {
	await kv.set("active_csv", ACTIVE_CSV);
	await kv.set("active_timestamp_csv", Date.now());
}

describe("per-NORAD lookups", () => {
	test("a catalog number is extracted from the active group with no upstream call", async () => {
		await warmActive();

		const result = await getNoradData(25544, "csv");

		expect(result.data).toContain("ISS (ZARYA)");
		expect(upstreamCalls).toHaveLength(0);
	});

	test("an unknown catalog number never produces a Celestrak request", async () => {
		await warmActive();

		await expect(getNoradData(runBase, "csv")).rejects.toThrow();

		expect(upstreamCalls).toHaveLength(0);
	});

	test("concurrent misses do not fan out to Celestrak", async () => {
		await warmActive();

		const results = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => getNoradData(runBase + i, "csv")));

		expect(results.every((r) => r.status === "rejected")).toBe(true);
		expect(upstreamCalls.filter((u) => u.includes("CATNR"))).toHaveLength(0);
		expect(upstreamCalls).toHaveLength(0);
	});

	test("a cold instance fetches the active group once for many misses", async () => {
		const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => getNoradData(runBase + i, "csv")));

		expect(results.every((r) => r.status === "rejected")).toBe(true);
		expect(upstreamCalls.filter((u) => u.includes("GROUP=active"))).toHaveLength(1);
		expect(upstreamCalls.filter((u) => u.includes("CATNR"))).toHaveLength(0);
	});

	test("Space-Track answers when configured and Celestrak is still untouched", async () => {
		config.spacetrackUser = "operator@example.com";
		config.spacetrackPassword = "secret";
		await warmActive();

		globalThis.fetch = (async (input: string | URL) => {
			const url = String(input);
			if (url.includes("space-track.org")) {
				if (url.endsWith("/ajaxauth/login")) {
					return new Response("", { status: 200, headers: { "set-cookie": "chocolatechip=s1; Path=/" } });
				}
				return new Response(
					JSON.stringify([
						{
							OBJECT_NAME: "DEAD SAT",
							OBJECT_ID: "2020-001A",
							EPOCH: "2026-11-19T00:00:00",
							MEAN_MOTION: "15.1",
							ECCENTRICITY: "0.001",
							INCLINATION: "53",
							RA_OF_ASC_NODE: "1",
							ARG_OF_PERICENTER: "2",
							MEAN_ANOMALY: "3",
							EPHEMERIS_TYPE: "0",
							CLASSIFICATION_TYPE: "U",
							NORAD_CAT_ID: String(runBase),
							ELEMENT_SET_NO: "999",
							REV_AT_EPOCH: "10",
							BSTAR: "0",
							MEAN_MOTION_DOT: "0",
							MEAN_MOTION_DDOT: "0",
						},
					]),
					{ status: 200 },
				);
			}
			upstreamCalls.push(url);
			return new Response(ACTIVE_CSV, { status: 200 });
		}) as unknown as typeof fetch;

		const result = await getNoradData(runBase, "csv");

		expect(result.data).toContain("DEAD SAT");
		expect(upstreamCalls).toHaveLength(0);
	});

	test("a repeated unknown id is answered locally for six hours", async () => {
		await warmActive();

		await expect(getNoradData(runBase, "csv")).rejects.toThrow();
		const missingUntil = (await kv.get(`norad_${runBase}_missing`)) as number;
		expect(missingUntil).toBeGreaterThan(Date.now() + 5 * 60 * 60 * 1000);

		await expect(getNoradData(runBase, "csv")).rejects.toThrow();
		expect(upstreamCalls).toHaveLength(0);
	});

	test("Last-Modified reports the element epoch, not the cache stamp", async () => {
		await warmActive();

		const response = await handleNoradRequest("25544", "csv");

		expect(response.status).toBe(200);
		expect(response.headers.get("last-modified")).toBe("Thu, 19 Nov 2026 06:28:00 GMT");
	});
});
