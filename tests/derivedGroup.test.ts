import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { isDerivedGroup, getSourceGroup, getDerivedGroupFormat, getDerivedGroupTimestamp } from "../src/utils/derivedGroup";
import { parseOmmCsv, csvTo3le, csvToJson } from "../src/utils/omm";
import { readFileSync } from "fs";
import { join } from "path";

const examplesDir = join(import.meta.dir, "..", "examples");
const issCsv = readFileSync(join(examplesDir, "iss.csv"), "utf-8");

const mockCsv = `OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE,ARG_OF_PERICENTER,MEAN_ANOMALY,EPHEMERIS_TYPE,CLASSIFICATION_TYPE,NORAD_CAT_ID,ELEMENT_SET_NO,REV_AT_EPOCH,BSTAR,MEAN_MOTION_DOT,MEAN_MOTION_DDOT
ISS (ZARYA),1998-067A,2026-08-06T01:17:37.872384,15.49359774,0.00072161,51.6321,53.3065,17.1615,342.9616,0,U,25544,999,57948,0.00007969016,0.00003997,0
STARLINK-1001,2019-067A,2026-08-06T01:17:37.872384,15.49359774,0.00072161,51.6321,53.3065,17.1615,342.9616,0,U,44001,999,57948,0.00007969016,0.00003997,0
STARLINK-1002,2019-067B,2026-08-06T01:17:37.872384,15.49359774,0.00072161,51.6321,53.3065,17.1615,342.9616,0,U,44002,999,57948,0.00007969016,0.00003997,0
STARLINK-3001,2020-001A,2026-08-06T01:17:37.872384,15.49359774,0.00072161,51.6321,53.3065,17.1615,342.9616,0,U,45001,999,57948,0.00007969016,0.00003997,0
HUBBLE SPACE TELESCOPE,1990-037B,2026-08-06T01:17:37.872384,15.49359774,0.00072161,51.6321,53.3065,17.1615,342.9616,0,U,20580,999,57948,0.00007969016,0.00003997,0
starlink-1003,2019-067C,2026-08-06T01:17:37.872384,15.49359774,0.00072161,51.6321,53.3065,17.1615,342.9616,0,U,44003,999,57948,0.00007969016,0.00003997,0
`;

// Requested demo members plus the operational Galileo (IOV/FOC) NORAD IDs from Celestrak's GALILEO group.
const demoRequestedIds = [1361, 43689, 38771, 36037, 62256, 25989, 47719, 25415, 25982, 43056, 40545, 61183, 49810];
const demoGalileoIds = [
	37846, 37847, 38857, 40128, 40129, 40544, 40545, 40890, 41174, 41175, 41549, 41550, 41859, 41860, 41861, 41862, 43055, 43056,
	43057, 43058, 43564, 43565, 43566, 43567, 49809, 49810, 59598, 59600, 61182, 61183, 67160, 67162,
];
const demoExpectedIds = [...new Set([...demoRequestedIds, ...demoGalileoIds])];

const mockCsvHeader = mockCsv.split("\n")[0] ?? "";

function demoCsvRow(noradId: number): string {
	return `SAT-${noradId},2020-001A,2026-08-06T01:17:37.872384,15.49359774,0.00072161,51.6321,53.3065,17.1615,342.9616,0,U,${noradId},999,57948,0.00007969016,0.00003997,0`;
}

function buildDemoCsv(noradIds: number[]): string {
	return [mockCsvHeader, ...noradIds.map(demoCsvRow)].join("\n") + "\n";
}

describe("isDerivedGroup", () => {
	test("identifies active-no-starlink as derived", () => {
		expect(isDerivedGroup("active-no-starlink")).toBe(true);
	});

	test("identifies demo as derived", () => {
		expect(isDerivedGroup("demo")).toBe(true);
	});

	test("identifies active as not derived", () => {
		expect(isDerivedGroup("active")).toBe(false);
	});

	test("identifies unknown groups as not derived", () => {
		expect(isDerivedGroup("starlink-1001")).toBe(false);
		expect(isDerivedGroup("nonexistent")).toBe(false);
	});
});

describe("getSourceGroup", () => {
	test("returns 'active' for active-no-starlink", () => {
		expect(getSourceGroup("active-no-starlink")).toBe("active");
	});

	test("returns 'active' for demo", () => {
		expect(getSourceGroup("demo")).toBe("active");
	});

	test("returns null for non-derived groups", () => {
		expect(getSourceGroup("active")).toBeNull();
		expect(getSourceGroup("nonexistent")).toBeNull();
	});
});

describe("getDerivedGroupFormat", () => {
	beforeEach(async () => {
		const kv = (await import("../src/utils/kv")).default;
		await kv.set("active_csv", mockCsv);
		await kv.set("active_timestamp_csv", Date.now());
	});

	afterEach(async () => {
		const kv = (await import("../src/utils/kv")).default;
		await kv.delete("active_csv");
		await kv.delete("active_timestamp_csv");
	});

	test("filters out Starlink satellites from CSV", async () => {
		const result = await getDerivedGroupFormat("active-no-starlink", "csv");
		const records = parseOmmCsv(result);

		expect(records).toHaveLength(2);
		expect(records[0]?.OBJECT_NAME).toBe("ISS (ZARYA)");
		expect(records[1]?.OBJECT_NAME).toBe("HUBBLE SPACE TELESCOPE");
	});

	test("filters out lowercase starlink names too", async () => {
		const result = await getDerivedGroupFormat("active-no-starlink", "csv");
		const records = parseOmmCsv(result);

		for (const rec of records) {
			expect(rec.OBJECT_NAME.toUpperCase().startsWith("STARLINK")).toBe(false);
		}
	});

	test("derives TLE format from filtered CSV", async () => {
		const result = await getDerivedGroupFormat("active-no-starlink", "tle");
		const lines = result.trim().split("\n");

		expect(lines).toHaveLength(6);

		expect(lines[0]).toBe("ISS (ZARYA)             ");
		expect(lines[1]?.startsWith("1 ")).toBe(true);
		expect(lines[2]?.startsWith("2 ")).toBe(true);

		expect(lines[3]).toBe("HUBBLE SPACE TELESCOPE  ");
		expect(lines[4]?.startsWith("1 ")).toBe(true);
		expect(lines[5]?.startsWith("2 ")).toBe(true);
	});

	test("derives JSON format from filtered CSV", async () => {
		const result = await getDerivedGroupFormat("active-no-starlink", "json");
		const records = JSON.parse(result);

		expect(records).toHaveLength(2);
		expect(records[0]?.OBJECT_NAME).toBe("ISS (ZARYA)");
		expect(records[1]?.OBJECT_NAME).toBe("HUBBLE SPACE TELESCOPE");
	});

	test("throws for unknown derived group", async () => {
		await expect(getDerivedGroupFormat("nonexistent", "csv")).rejects.toThrow("Unknown derived group");
	});

	test("throws when source group has no cached CSV", async () => {
		const kv = (await import("../src/utils/kv")).default;
		await kv.delete("active_csv");

		await expect(getDerivedGroupFormat("active-no-starlink", "csv")).rejects.toThrow("no cached CSV data");

		await kv.set("active_csv", mockCsv);
	});
});

describe("getDerivedGroupTimestamp", () => {
	beforeEach(async () => {
		const kv = (await import("../src/utils/kv")).default;
		await kv.set("active_csv", mockCsv);
		await kv.set("active_timestamp_csv", 1234567890);
	});

	afterEach(async () => {
		const kv = (await import("../src/utils/kv")).default;
		await kv.delete("active_csv");
		await kv.delete("active_timestamp_csv");
	});

	test("returns source group's CSV timestamp", async () => {
		const ts = await getDerivedGroupTimestamp("active-no-starlink");
		expect(ts).toBe(1234567890);
	});

	test("returns null for non-derived groups", async () => {
		const ts = await getDerivedGroupTimestamp("active");
		expect(ts).toBeNull();
	});
});

describe("demo derived group", () => {
	beforeEach(async () => {
		const kv = (await import("../src/utils/kv")).default;
		await kv.set("active_csv", buildDemoCsv([...demoExpectedIds, 99999]));
		await kv.set("active_timestamp_csv", Date.now());
	});

	afterEach(async () => {
		const kv = (await import("../src/utils/kv")).default;
		await kv.delete("active_csv");
		await kv.delete("active_timestamp_csv");
	});

	test("includes the requested NORAD IDs", async () => {
		const result = await getDerivedGroupFormat("demo", "csv");
		const ids = new Set(parseOmmCsv(result).map((rec) => rec.NORAD_CAT_ID));

		for (const id of demoRequestedIds) {
			expect(ids.has(id)).toBe(true);
		}
	});

	test("includes the operational Galileo additions and deduplicates", async () => {
		const result = await getDerivedGroupFormat("demo", "csv");
		const ids = new Set(parseOmmCsv(result).map((rec) => rec.NORAD_CAT_ID));

		for (const id of demoGalileoIds) {
			expect(ids.has(id)).toBe(true);
		}

		expect(ids.size).toBe(demoExpectedIds.length);
	});

	test("exposes exactly the allowlisted satellites present in active", async () => {
		const result = await getDerivedGroupFormat("demo", "json");
		const ids = (JSON.parse(result) as { NORAD_CAT_ID: number }[]).map((rec) => rec.NORAD_CAT_ID).sort((a, b) => a - b);
		const expected = [...demoExpectedIds].sort((a, b) => a - b);

		expect(ids).toEqual(expected);
		expect(ids.includes(99999)).toBe(false);
	});

	test("only exposes allowlisted satellites that are present in active", async () => {
		const kv = (await import("../src/utils/kv")).default;
		await kv.set("active_csv", buildDemoCsv([1361, 40545, 67162]));

		const result = await getDerivedGroupFormat("demo", "csv");
		const ids = parseOmmCsv(result)
			.map((rec) => rec.NORAD_CAT_ID)
			.sort((a, b) => a - b);

		expect(ids).toEqual([1361, 40545, 67162]);
	});
});
