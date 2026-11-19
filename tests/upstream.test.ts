import { afterEach, describe, expect, test } from "bun:test";
import kv from "../src/utils/kv";
import config from "../src/utils/config";
import { coalesce, serialize, upstreamFetch, resetUpstreamState } from "../src/utils/upstream";
import {
	FAILURE_STREAK_KEY,
	LOCKOUT_KEY,
	NOT_FOUND_STREAK_KEY,
	clearCelestrakFailures,
	getFailureStreak,
	isCelestrakLockedOut,
	noteNoradNotFound,
	triggerCelestrakLockout,
} from "../src/utils/lockout";

afterEach(async () => {
	resetUpstreamState();
	await kv.delete(LOCKOUT_KEY);
	await kv.delete(NOT_FOUND_STREAK_KEY);
	await clearCelestrakFailures();
});

describe("coalesce", () => {
	test("concurrent callers share a single upstream attempt", async () => {
		let calls = 0;
		const fn = async () => {
			calls++;
			await new Promise((resolve) => setTimeout(resolve, 10));
			return "data";
		};

		const [a, b, c] = await Promise.all([coalesce("group:active", fn), coalesce("group:active", fn), coalesce("group:active", fn)]);

		expect(calls).toBe(1);
		expect(a).toBe("data");
		expect(b).toBe("data");
		expect(c).toBe("data");
	});

	test("different keys do not share a request", async () => {
		let calls = 0;
		const fn = async () => {
			calls++;
			return calls;
		};

		await Promise.all([coalesce("a", fn), coalesce("b", fn)]);
		expect(calls).toBe(2);
	});

	test("a failed attempt is not cached", async () => {
		let calls = 0;
		const fn = async () => {
			calls++;
			throw new Error("boom");
		};

		await expect(coalesce("fail", fn)).rejects.toThrow("boom");
		await expect(coalesce("fail", fn)).rejects.toThrow("boom");
		expect(calls).toBe(2);
	});
});

describe("serialize", () => {
	test("critical sections never interleave", async () => {
		const order: string[] = [];
		const task = (name: string) =>
			serialize(async () => {
				order.push(`${name}:in`);
				await new Promise((resolve) => setTimeout(resolve, 5));
				order.push(`${name}:out`);
			});

		await Promise.all([task("a"), task("b"), task("c")]);

		expect(order).toEqual(["a:in", "a:out", "b:in", "b:out", "c:in", "c:out"]);
	});
});

describe("upstreamFetch", () => {
	test("runs upstream requests one at a time", async () => {
		const originalFetch = globalThis.fetch;
		const originalSpacing = config.upstreamMinSpacingMs;
		let active = 0;
		let peak = 0;

		config.upstreamMinSpacingMs = 0;
		globalThis.fetch = (async () => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 20));
			active--;
			return new Response("ok", { status: 200 });
		}) as unknown as typeof fetch;

		try {
			await Promise.all([upstreamFetch("https://example.test/1"), upstreamFetch("https://example.test/2"), upstreamFetch("https://example.test/3")]);
		} finally {
			globalThis.fetch = originalFetch;
			config.upstreamMinSpacingMs = originalSpacing;
		}

		expect(peak).toBe(1);
	});

	test("propagates network errors to the caller", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			throw new Error("connect timeout");
		}) as unknown as typeof fetch;

		try {
			await expect(upstreamFetch("https://example.test/1")).rejects.toThrow("connect timeout");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("failure backoff", () => {
	test("network failures escalate instead of retrying on a fixed interval", async () => {
		await kv.delete(LOCKOUT_KEY);
		await clearCelestrakFailures();

		const first = (await triggerCelestrakLockout("network", "test"))!;
		const second = (await triggerCelestrakLockout("network", "test"))!;

		expect(first - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000 + 1000);
		expect(second - first).toBeGreaterThan(5 * 60 * 1000);
		expect(await getFailureStreak()).toBe(2);
	});

	test("repeated HTTP blocks escalate past the base lockout duration", async () => {
		await kv.delete(LOCKOUT_KEY);
		await clearCelestrakFailures();

		const first = (await triggerCelestrakLockout(403, "test"))!;
		const second = (await triggerCelestrakLockout(403, "test"))!;

		expect(first - Date.now()).toBeGreaterThanOrEqual(config.celestrakLockDuration - 1000);
		expect(second - first).toBeGreaterThanOrEqual(config.celestrakLockDuration);
	});

	test("a successful fetch resets the streak", async () => {
		await triggerCelestrakLockout(403, "test");
		expect(await getFailureStreak()).toBe(1);

		await clearCelestrakFailures();
		expect(await kv.get(FAILURE_STREAK_KEY)).toBeFalsy();
	});
});

describe("consecutive 404s", () => {
	test("a run of unknowns trips the lockout, one alone does not", async () => {
		const originalLimit = config.maxConsecutiveNotFound;
		config.maxConsecutiveNotFound = 3;
		await kv.delete(LOCKOUT_KEY);
		await kv.delete(NOT_FOUND_STREAK_KEY);

		try {
			await noteNoradNotFound("NORAD ID 1");
			expect((await isCelestrakLockedOut()).locked).toBe(false);

			await noteNoradNotFound("NORAD ID 2");
			expect((await isCelestrakLockedOut()).locked).toBe(false);

			await noteNoradNotFound("NORAD ID 3");
			expect((await isCelestrakLockedOut()).locked).toBe(true);
		} finally {
			config.maxConsecutiveNotFound = originalLimit;
		}
	});

	test("a second storm inside the window backs off further", async () => {
		const originalLimit = config.maxConsecutiveNotFound;
		config.maxConsecutiveNotFound = 2;
		await kv.delete(LOCKOUT_KEY);
		await kv.delete(NOT_FOUND_STREAK_KEY);

		try {
			await noteNoradNotFound("NORAD ID 1");
			await noteNoradNotFound("NORAD ID 2");
			const firstUntil = (await isCelestrakLockedOut()).untilMs!;

			await noteNoradNotFound("NORAD ID 3");
			await noteNoradNotFound("NORAD ID 4");
			const secondUntil = (await isCelestrakLockedOut()).untilMs!;

			expect(secondUntil - firstUntil).toBeGreaterThan(9 * 60 * 1000);
		} finally {
			config.maxConsecutiveNotFound = originalLimit;
		}
	});
});
