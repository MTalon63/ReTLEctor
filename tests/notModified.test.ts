import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import kv from "../src/utils/kv";
import config from "../src/utils/config";
import { resetUpstreamState } from "../src/utils/upstream";
import { resetCelestrakState, isCelestrakLockedOut } from "../src/utils/lockout";
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
	await resetCelestrakState();
	config.upstreamMinSpacingMs = 0;
	await kv.set("stations_csv", CSV);
	await kv.set("stations_timestamp_csv", Date.now() - 5 * 60 * 60 * 1000);
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	config.upstreamMinSpacingMs = originalSpacing;
	await resetCelestrakState();
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

describe("group 404", () => {
	test("an upstream 404 is cached instead of re-requested", async () => {
		let hits = 0;
		globalThis.fetch = (async () => {
			hits++;
			return new Response("Group not found", { status: 404 });
		}) as unknown as typeof fetch;
		await kv.delete("bogus-group_csv");
		await kv.delete("group_missing:bogus-group");

		await expect(fetchTle("bogus-group", "csv")).rejects.toThrow();
		await expect(fetchTle("bogus-group", "csv")).rejects.toThrow();

		expect(hits).toBe(1);
		await kv.delete("group_missing:bogus-group");
	});
});

describe("301 redirects", () => {
	test("a redirect is followed once and the new endpoint is remembered", async () => {
		const seen: string[] = [];
		globalThis.fetch = (async (input: string | URL) => {
			const url = String(input);
			seen.push(url);
			if (url.startsWith("https://celestrak.org/NORAD/elements/gp.php")) {
				return new Response(null, {
					status: 301,
					headers: { location: "https://celestrak.org/NORAD/gp-new.php?GROUP=stations&FORMAT=csv" },
				});
			}
			return new Response(CSV, { status: 200 });
		}) as unknown as typeof fetch;
		await kv.delete("celestrak_url_current");
		await resetCelestrakState();

		const body = await fetchTle("stations", "csv");

		expect(body).toContain("ISS (ZARYA)");
		expect(seen).toHaveLength(2);
		expect(seen[1]).toContain("/NORAD/gp-new.php");
		expect(seen[1]).toContain("GROUP=stations");
		expect((await kv.get("celestrak_url_current")) as string).toBe("https://celestrak.org/NORAD/gp-new.php");
	});

	test("the remembered endpoint is used for the next refresh without a redirect", async () => {
		const seen: string[] = [];
		globalThis.fetch = (async (input: string | URL) => {
			seen.push(String(input));
			return new Response(CSV, { status: 200 });
		}) as unknown as typeof fetch;

		await fetchTle("stations", "csv");

		expect(seen).toHaveLength(1);
		expect(seen[0]).toContain("/NORAD/gp-new.php");
		await kv.delete("celestrak_url_current");
	});
});
});
