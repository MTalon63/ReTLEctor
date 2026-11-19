import { describe, expect, test } from "bun:test";
import { csvTo3le, parse3le } from "../src/utils/omm";

const HEADER =
	"OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE,ARG_OF_PERICENTER,MEAN_ANOMALY,EPHEMERIS_TYPE,CLASSIFICATION_TYPE,NORAD_CAT_ID,ELEMENT_SET_NO,REV_AT_EPOCH,BSTAR,MEAN_MOTION_DOT,MEAN_MOTION_DDOT\n";

function row(overrides: Partial<Record<string, string>> = {}): string {
	const base: Record<string, string> = {
		OBJECT_NAME: "TEST SAT",
		OBJECT_ID: "1998-067A",
		EPOCH: "2026-08-06T01:17:37.872384",
		MEAN_MOTION: "15.49359774",
		ECCENTRICITY: "0.00072161",
		INCLINATION: "51.6321",
		RA_OF_ASC_NODE: "53.3065",
		ARG_OF_PERICENTER: "17.1615",
		MEAN_ANOMALY: "342.9616",
		EPHEMERIS_TYPE: "0",
		CLASSIFICATION_TYPE: "U",
		NORAD_CAT_ID: "25544",
		ELEMENT_SET_NO: "999",
		REV_AT_EPOCH: "57948",
		BSTAR: "0.00007969016",
		MEAN_MOTION_DOT: "0.00003997",
		MEAN_MOTION_DDOT: "0",
	};
	const merged = { ...base, ...overrides };

	return [
		merged.OBJECT_NAME,
		merged.OBJECT_ID,
		merged.EPOCH,
		merged.MEAN_MOTION,
		merged.ECCENTRICITY,
		merged.INCLINATION,
		merged.RA_OF_ASC_NODE,
		merged.ARG_OF_PERICENTER,
		merged.MEAN_ANOMALY,
		merged.EPHEMERIS_TYPE,
		merged.CLASSIFICATION_TYPE,
		merged.NORAD_CAT_ID,
		merged.ELEMENT_SET_NO,
		merged.REV_AT_EPOCH,
		merged.BSTAR,
		merged.MEAN_MOTION_DOT,
		merged.MEAN_MOTION_DDOT,
	].join(",");
}

describe("TLE numeric fields", () => {
	test("negative BSTAR keeps its sign in line 1", () => {
		const tle = csvTo3le(HEADER + row({ BSTAR: "-0.0000123456" }));
		const line1 = tle.split("\n")[1]!;

		expect(line1).toHaveLength(69);
		expect(line1.substring(53, 61)).toBe("-12346-4");
	});

	test("positive BSTAR keeps the blank sign column", () => {
		const tle = csvTo3le(HEADER + row({ BSTAR: "0.00007969016" }));
		const line1 = tle.split("\n")[1]!;

		expect(line1.substring(53, 61)).toBe(" 79690-4");
	});

	test("BSTAR mantissa rounding does not overflow the field", () => {
		const tle = csvTo3le(HEADER + row({ BSTAR: "0.000999999" }));
		const line1 = tle.split("\n")[1]!;

		expect(line1).toHaveLength(69);
		expect(line1.substring(53, 61)).toBe(" 10000-2");
	});

	test("negative MEAN_MOTION_DDOT keeps its sign", () => {
		const tle = csvTo3le(HEADER + row({ MEAN_MOTION_DDOT: "-0.00000012345" }));
		const line1 = tle.split("\n")[1]!;

		expect(line1).toHaveLength(69);
		expect(line1.substring(44, 52)).toBe("-12345-6");
	});

	test("overlong international designator is truncated, not shifted", () => {
		const tle = csvTo3le(HEADER + row({ OBJECT_ID: "1998-067ABCDEFGH" }));
		const line1 = tle.split("\n")[1]!;

		expect(line1).toHaveLength(69);
		expect(line1[0]).toBe("1");
		expect(line1.substring(18, 20)).toMatch(/^\d{2}$/);
	});

	test("fields beyond their fixed width cannot break the 69-character line", () => {
		const tle = csvTo3le(HEADER + row({ NORAD_CAT_ID: "A1234", ELEMENT_SET_NO: "123456" }));
		const lines = tle.trim().split("\n");

		expect(lines[1]).toHaveLength(69);
		expect(lines[2]).toHaveLength(69);
	});
});

describe("parse3le", () => {
	test("round-trips a negative BSTAR", () => {
		const tle = csvTo3le(HEADER + row({ BSTAR: "-0.0000123456" }));
		const records = parse3le(tle);

		expect(records).toHaveLength(1);
		expect(records[0]!.BSTAR).toBeCloseTo(-1.2346e-5, 12);
	});

	test("accepts a 2-line element set without a name line", () => {
		const tle = csvTo3le(HEADER + row());
		const lines = tle.trim().split("\n");
		const twoLine = [lines[1]!, lines[2]!, lines[1]!, lines[2]!].join("\n");
		const records = parse3le(twoLine);

		expect(records).toHaveLength(2);
		expect(records[0]!.NORAD_CAT_ID).toBe(25544);
		expect(records[1]!.NORAD_CAT_ID).toBe(25544);
	});
});
