import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import config from "../src/utils/config";
import {
	fetchGpByNoradId,
	gpIndexSize,
	refreshGpIndex,
	resetSpaceTrackSession,
	spaceTrackEnabled,
} from "../src/utils/spacetrack";

const HEADER =
	"OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE,ARG_OF_PERICENTER,MEAN_ANOMALY,EPHEMERIS_TYPE,CLASSIFICATION_TYPE,NORAD_CAT_ID,ELEMENT_SET_NO,REV_AT_EPOCH,BSTAR,MEAN_MOTION_DOT,MEAN_MOTION_DDOT";

const GP_CSV = `${HEADER}
ISS (ZARYA),1998-067A,2026-11-19T06:28:00.055776,15.49482233,.00074107,51.6317,252.6441,42.3196,317.8363,0,U,25544,999,59579,.25566563E-3,.13909E-3,0
`;

const originalFetch = globalThis.fetch;
const originalUser = config.spacetrackUser;
const originalPass = config.spacetrackPassword;
const originalMaxAge = config.spacetrackMaxAgeDays;
const originalIndexFile = config.gpIndexFile;

interface Call {
	url: string;
	method?: string;
	cookie?: string | null;
	body?: string;
}

let calls: Call[] = [];
let indexFile = "";

function stubSpaceTrack(options: { gpBody?: string; loginBody?: string; loginOk?: boolean } = {}): void {
	calls = [];
	globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
		const url = String(input);
		const headers = new Headers(init.headers);
		calls.push({ url, method: init.method, cookie: headers.get("cookie"), body: String(init.body ?? "") });

		if (url.endsWith("/ajaxauth/login")) {
			if (options.loginOk === false) return new Response("nope", { status: 401 });
			return new Response(options.loginBody ?? "", {
				status: 200,
				headers: { "set-cookie": "chocolatechip=session-abc; Path=/; HttpOnly" },
			});
		}

		return new Response(options.gpBody ?? GP_CSV, { status: 200 });
	}) as unknown as typeof fetch;
}

beforeEach(() => {
	resetSpaceTrackSession();
	indexFile = join(tmpdir(), `retlector-gp-${Math.random().toString(36).slice(2)}.csv`);
	config.gpIndexFile = indexFile;
	config.spacetrackUser = "operator@example.com";
	config.spacetrackPassword = "secret";
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	config.spacetrackUser = originalUser;
	config.spacetrackPassword = originalPass;
	config.spacetrackMaxAgeDays = originalMaxAge;
	config.gpIndexFile = originalIndexFile;
	resetSpaceTrackSession();
	await rm(indexFile, { force: true });
});

describe("space-track bulk GP index", () => {
	test("is disabled without credentials", async () => {
		config.spacetrackUser = null;
		config.spacetrackPassword = null;

		expect(spaceTrackEnabled()).toBe(false);
		expect(await refreshGpIndex(true)).toBe(0);
		expect(await fetchGpByNoradId(25544)).toBeNull();
		expect(calls).toHaveLength(0);
	});

	test("one bulk request per refresh, never a per-object query", async () => {
		stubSpaceTrack();

		const received = await refreshGpIndex(true);

		expect(received).toBe(1);
		expect(calls.filter((call) => call.url.endsWith("/ajaxauth/login"))).toHaveLength(1);
		const gpCalls = calls.filter((call) => call.url.includes("/class/gp/"));
		expect(gpCalls).toHaveLength(1);
		expect(gpCalls[0]!.url).toContain("/class/gp/decay_date/null-val/CREATION_DATE/");
		expect(gpCalls[0]!.url).toContain("format/csv");
		expect(gpCalls[0]!.cookie).toContain("chocolatechip=session-abc");
		expect(await gpIndexSize()).toBe(1);
	});

	test("a per-object lookup is answered from the index with no request", async () => {
		stubSpaceTrack();
		await refreshGpIndex(true);
		const afterRefresh = calls.length;

		const record = await fetchGpByNoradId(25544);

		expect(record?.OBJECT_NAME).toBe("ISS (ZARYA)");
		expect(record?.MEAN_MOTION).toBeCloseTo(15.49482233, 8);
		expect(calls).toHaveLength(afterRefresh);
	});

	test("an unknown catalog number costs no request", async () => {
		stubSpaceTrack();
		await refreshGpIndex(true);
		const afterRefresh = calls.length;

		expect(await fetchGpByNoradId(999999)).toBeNull();
		expect(calls).toHaveLength(afterRefresh);
	});

	test("a refresh inside the hour is skipped", async () => {
		stubSpaceTrack();
		await refreshGpIndex(true);
		const afterFirst = calls.length;

		expect(await refreshGpIndex()).toBe(0);
		expect(calls).toHaveLength(afterFirst);
	});

	test("a repeat catalog number keeps the newer epoch", async () => {
		stubSpaceTrack();
		await refreshGpIndex(true);

		const newer = GP_CSV.replace("2026-11-19T06:28:00.055776", "2026-11-20T06:28:00.055776").replace("59579", "59600");
		stubSpaceTrack({ gpBody: newer });
		await refreshGpIndex(true);

		const record = await fetchGpByNoradId(25544);

		expect(record?.EPOCH).toBe("2026-11-20T06:28:00.055776");
		expect(record?.REV_AT_EPOCH).toBe(59600);
		expect(await gpIndexSize()).toBe(1);
	});

	test("a stale element set is treated as no data", async () => {
		config.spacetrackMaxAgeDays = 30;
		stubSpaceTrack({ gpBody: GP_CSV.replace("2026-11-19T06:28:00.055776", "2025-04-09T17:26:22") });
		await refreshGpIndex(true);

		expect(await fetchGpByNoradId(25544)).toBeNull();
	});

	test("the staleness guard can be switched off", async () => {
		config.spacetrackMaxAgeDays = 0;
		stubSpaceTrack({ gpBody: GP_CSV.replace("2026-11-19T06:28:00.055776", "2025-04-09T17:26:22") });
		await refreshGpIndex(true);

		expect((await fetchGpByNoradId(25544))?.OBJECT_NAME).toBe("ISS (ZARYA)");
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

			return new Response(GP_CSV, { status: 200 });
		}) as unknown as typeof fetch;

		expect(await refreshGpIndex(true)).toBe(1);
		expect(gpCalls).toBe(2);
		expect(calls.filter((call) => call.url.endsWith("/ajaxauth/login"))).toHaveLength(2);
	});

	test("a 200 Login:Failed body is a rejection and suspends logins", async () => {
		stubSpaceTrack({ loginBody: '{"Login":"Failed"}' });

		await expect(refreshGpIndex(true)).rejects.toThrow(/rejected/i);
		expect(calls.some((call) => call.url.includes("/class/gp/"))).toBe(false);

		const afterFirst = calls.length;
		await expect(refreshGpIndex(true)).rejects.toThrow(/suspended/i);
		expect(calls).toHaveLength(afterFirst);
	});
});
