import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import config from "../src/utils/config";
import { fetchGpByNoradId, resetSpaceTrackSession, spaceTrackEnabled } from "../src/utils/spacetrack";

const GP_JSON = JSON.stringify([
	{
		CCSDS_OMM_VERS: "2.0",
		OBJECT_NAME: "ISS (ZARYA)",
		OBJECT_ID: "1998-067A",
		EPOCH: "2026-11-19T06:28:00.055776",
		MEAN_MOTION: "15.49482233",
		ECCENTRICITY: "0.00074107",
		INCLINATION: "51.6317",
		RA_OF_ASC_NODE: "252.6441",
		ARG_OF_PERICENTER: "42.3196",
		MEAN_ANOMALY: "317.8363",
		EPHEMERIS_TYPE: "0",
		CLASSIFICATION_TYPE: "U",
		NORAD_CAT_ID: "25544",
		ELEMENT_SET_NO: "999",
		REV_AT_EPOCH: "59579",
		BSTAR: "0.00025566563",
		MEAN_MOTION_DOT: "0.00013909",
		MEAN_MOTION_DDOT: "0",
	},
]);

const originalFetch = globalThis.fetch;
const originalUser = config.spacetrackUser;
const originalPass = config.spacetrackPassword;
const originalSpacing = config.spacetrackMinSpacingMs;
const originalMaxAge = config.spacetrackMaxAgeDays;

interface Call {
	url: string;
	method?: string;
	cookie?: string | null;
	body?: string;
}

let calls: Call[] = [];

function stubSpaceTrack(options: { gpBody?: string; loginOk?: boolean } = {}): void {
	calls = [];
	globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
		const url = String(input);
		const headers = new Headers(init.headers);
		calls.push({ url, method: init.method, cookie: headers.get("cookie"), body: String(init.body ?? "") });

		if (url.endsWith("/ajaxauth/login")) {
			if (options.loginOk === false) return new Response("bad credentials", { status: 401 });
			return new Response("", { status: 200, headers: { "set-cookie": "chocolatechip=session-abc; Path=/; HttpOnly" } });
		}

		return new Response(options.gpBody ?? GP_JSON, { status: 200 });
	}) as unknown as typeof fetch;
}

beforeEach(() => {
	resetSpaceTrackSession();
	config.spacetrackUser = "operator@example.com";
	config.spacetrackPassword = "secret";
	config.spacetrackMinSpacingMs = 0;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	config.spacetrackUser = originalUser;
	config.spacetrackPassword = originalPass;
	config.spacetrackMinSpacingMs = originalSpacing;
	config.spacetrackMaxAgeDays = originalMaxAge;
	resetSpaceTrackSession();
});

describe("space-track client", () => {
	test("is disabled without credentials", async () => {
		config.spacetrackUser = null;
		config.spacetrackPassword = null;

		expect(spaceTrackEnabled()).toBe(false);
		expect(await fetchGpByNoradId(25544)).toBeNull();
	});

	test("logs in, queries gp by catalog number and returns numbers", async () => {
		stubSpaceTrack();

		const record = await fetchGpByNoradId(25544);

		expect(record?.OBJECT_NAME).toBe("ISS (ZARYA)");
		expect(record?.NORAD_CAT_ID).toBe(25544);
		expect(record?.MEAN_MOTION).toBeCloseTo(15.49482233, 8);
		expect(record?.BSTAR).toBeCloseTo(0.00025566563, 12);

		expect(calls[0]!.url).toBe("https://www.space-track.org/ajaxauth/login");
		expect(calls[0]!.method).toBe("POST");
		expect(calls[0]!.body).toContain("identity=operator%40example.com");

		expect(calls[1]!.url).toBe("https://www.space-track.org/basicspacedata/query/class/gp/NORAD_CAT_ID/25544/format/json");
		expect(calls[1]!.cookie).toContain("chocolatechip=session-abc");
	});

	test("reuses the session instead of logging in again", async () => {
		stubSpaceTrack();

		await fetchGpByNoradId(25544);
		await fetchGpByNoradId(36086);

		expect(calls.filter((c) => c.url.endsWith("/ajaxauth/login"))).toHaveLength(1);
		expect(calls.filter((c) => c.url.includes("/class/gp/"))).toHaveLength(2);
	});

	test("an empty result means no such object", async () => {
		stubSpaceTrack({ gpBody: "[]" });
		expect(await fetchGpByNoradId(999999)).toBeNull();
	});

	test("re-logs in once when the session is rejected", async () => {
		let gpCalls = 0;
		calls = [];
		globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
			const url = String(input);
			calls.push({ url, method: init.method });
			if (url.endsWith("/ajaxauth/login")) {
				return new Response("", { status: 200, headers: { "set-cookie": `chocolatechip=s${calls.length}; Path=/` } });
			}
			gpCalls++;
			if (gpCalls === 1) return new Response("unauthorized", { status: 401 });
			return new Response(GP_JSON, { status: 200 });
		}) as unknown as typeof fetch;

		const record = await fetchGpByNoradId(25544);

		expect(record?.NORAD_CAT_ID).toBe(25544);
		expect(calls.filter((c) => c.url.endsWith("/ajaxauth/login"))).toHaveLength(2);
		expect(gpCalls).toBe(2);
	});

	test("a stale element set is treated as no data", async () => {
		stubSpaceTrack({ gpBody: GP_JSON.replace("2026-11-19T06:28:00.055776", "2025-04-09T17:26:22") });

		expect(await fetchGpByNoradId(57482)).toBeNull();
	});

	test("the staleness guard can be switched off", async () => {
		config.spacetrackMaxAgeDays = 0;
		stubSpaceTrack({ gpBody: GP_JSON.replace("2026-11-19T06:28:00.055776", "2025-04-09T17:26:22") });

		const record = await fetchGpByNoradId(57482);

		expect(record?.OBJECT_NAME).toBe("ISS (ZARYA)");
	});
});
