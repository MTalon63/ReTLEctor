import { afterEach, describe, expect, test } from "bun:test";
import kv from "../src/utils/kv";
import config from "../src/utils/config";
import { coalesce, serialize, upstreamFetch, resetUpstreamState } from "../src/utils/upstream";
import {
	clearCelestrakFailures,
	FAILURE_STREAK_KEY,
	LOCKOUT_KEY,
	resetCelestrakState,
	getFailureStreak,
	isCelestrakLockedOut,
	triggerCelestrakLockout,
} from "../src/utils/lockout";

afterEach(async () => {
	resetUpstreamState();
	await kv.delete(LOCKOUT_KEY);
	await resetCelestrakState();
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
		await resetCelestrakState();

		const first = (await triggerCelestrakLockout("network", "test"))!;
		const second = (await triggerCelestrakLockout("network", "test"))!;

		expect(first - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000 + 1000);
		expect(second - first).toBeGreaterThan(5 * 60 * 1000);
	});

	test("a 5xx pause stays short and does not inherit the block ladder", async () => {
		await kv.delete(LOCKOUT_KEY);
		await resetCelestrakState();

		const blocked = (await triggerCelestrakLockout(403, "test"))!;
		const serverError = (await triggerCelestrakLockout(503, "test"))!;

		expect(blocked - Date.now()).toBeGreaterThan(11 * 60 * 60 * 1000);
		expect(serverError - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000 + 1000);
	});

	test("repeated HTTP blocks escalate past the base lockout duration", async () => {
		await kv.delete(LOCKOUT_KEY);
		await resetCelestrakState();

		const first = (await triggerCelestrakLockout(403, "test"))!;
		const second = (await triggerCelestrakLockout(403, "test"))!;

		expect(first - Date.now()).toBeGreaterThanOrEqual(config.celestrakLockDuration - 1000);
		expect(second - first).toBeGreaterThanOrEqual(config.celestrakLockDuration);
	});

	test("a success right after a failure keeps the ladder", async () => {
		await triggerCelestrakLockout(403, "test");
		expect(await getFailureStreak()).toBe(1);

		await clearCelestrakFailures();
		expect(await getFailureStreak()).toBe(1);
	});

	test("a success after a quiet window resets the streak", async () => {
		await triggerCelestrakLockout(403, "test");
		await kv.set("celestrak_last_failure_at", Date.now() - 31 * 60 * 1000);

		await clearCelestrakFailures();
		expect(await kv.get(FAILURE_STREAK_KEY)).toBeFalsy();
	});

	test("a stalled download is aborted", async () => {
		config.upstreamStallMs = 60;
		globalThis.fetch = (async () =>
			new Response(
				new ReadableStream({
					start(stream) {
						stream.enqueue(new TextEncoder().encode("partial"));
					},
				}),
			)) as unknown as typeof fetch;

		const response = await upstreamFetch("https://example.test/stall");

		await expect(response.text()).rejects.toThrow();
	});

	test("a slow but progressing download completes", async () => {
		config.upstreamStallMs = 120;
		globalThis.fetch = (async () =>
			new Response(
				new ReadableStream({
					async start(stream) {
						for (let i = 0; i < 3; i++) {
							stream.enqueue(new TextEncoder().encode("ab"));
							await new Promise((resolve) => setTimeout(resolve, 40));
						}
						stream.close();
					},
				}),
			)) as unknown as typeof fetch;

		const response = await upstreamFetch("https://example.test/slow");

		expect(await response.text()).toBe("ababab");
	});
});
