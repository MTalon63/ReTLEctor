import { describe, expect, test } from "bun:test";
import { resolveGroups } from "../src/utils/config";

describe("group resolution", () => {
	test("a special group is served without being named in ALLOWED_GROUPS", () => {
		const { allowedGroups, specialGroups } = resolveGroups("stations,visual", "gpz,gpz-plus,decaying");

		expect(specialGroups).toEqual(["gpz", "gpz-plus", "decaying"]);
		expect(allowedGroups).toContain("gpz");
		expect(allowedGroups).toContain("gpz-plus");
		expect(allowedGroups).toContain("stations");
		expect(allowedGroups).toContain("active");
	});

	test("naming one in both lists does not duplicate it", () => {
		const { allowedGroups } = resolveGroups("stations,gpz", "gpz");

		expect(allowedGroups.filter((group) => group === "gpz")).toHaveLength(1);
	});

	test("nothing extra is enabled when neither var is set", () => {
		const { allowedGroups, specialGroups } = resolveGroups(undefined, undefined);

		expect(allowedGroups).toEqual(["active", "active-no-starlink", "demo"]);
		expect(specialGroups).toEqual([]);
	});

	test("blank entries and stray spaces are ignored", () => {
		const { allowedGroups } = resolveGroups(" stations , ,visual ", " gpz ");

		expect(allowedGroups).toEqual(["active", "active-no-starlink", "demo", "stations", "visual", "gpz"]);
	});
});
