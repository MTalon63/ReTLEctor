import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import config from "../src/utils/config";
import { notifyUpstreamFailure, notifyUpstreamRecovered, resetAlertState } from "../src/utils/alerts";

const WEBHOOK = "https://discord.test/api/webhooks/123/abc";

interface Sent {
	url: string;
	body: { username?: string; embeds?: Array<{ title?: string; description?: string; color?: number; fields?: Array<{ name: string; value: string }> }> };
}

const originalFetch = globalThis.fetch;
const originalWebhook = config.discordWebhookUrl;
const originalThrottle = config.alertThrottleMs;
const originalMinInterval = config.alertMinIntervalMs;
let sent: Sent[] = [];

function stubFetch(status = 204): void {
	sent = [];
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		sent.push({ url: String(url), body: JSON.parse(String(init.body)) });
		return new Response("", { status });
	}) as unknown as typeof fetch;
}

beforeEach(() => {
	resetAlertState();
	config.discordWebhookUrl = WEBHOOK;
	config.alertThrottleMs = 5 * 60 * 1000;
	config.alertMinIntervalMs = 0;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	config.discordWebhookUrl = originalWebhook;
	config.alertThrottleMs = originalThrottle;
	config.alertMinIntervalMs = originalMinInterval;
	resetAlertState();
});

describe("discord alerts", () => {
	test("does nothing when no webhook is configured", async () => {
		stubFetch();
		config.discordWebhookUrl = null;

		await notifyUpstreamFailure({ status: 503, context: 'group "active"', streak: 1, durationMs: 12 * 60 * 60 * 1000, untilIso: "2026-11-17T12:03:22.000Z" });

		expect(sent).toHaveLength(0);
	});

	test("posts an embed for a non-200 upstream response", async () => {
		stubFetch();

		await notifyUpstreamFailure({ status: 403, context: 'group "active"', streak: 2, durationMs: 24 * 60 * 60 * 1000, untilIso: "2026-11-18T12:00:00.000Z" });

		expect(sent).toHaveLength(1);
		expect(sent[0]!.url).toBe(WEBHOOK);

		const embed = sent[0]!.body.embeds![0]!;
		expect(embed.title).toContain("HTTP 403");
		expect(embed.title).toContain('group "active"');
		expect(embed.color).toBe(0xed4245);
		expect(embed.fields?.map((f) => f.name)).toEqual(["Upstream", "Consecutive failures", "Paused for"]);
		expect(embed.fields?.[2]?.value).toContain("24h");
	});

	test("uses the server-error colour for 5xx", async () => {
		stubFetch();

		await notifyUpstreamFailure({ status: 503, context: 'group "active"', streak: 1, durationMs: 12 * 60 * 60 * 1000, untilIso: "2026-11-17T12:03:22.000Z" });

		expect(sent[0]!.body.embeds![0]!.color).toBe(0xfaa61a);
	});

	test("a network failure is reported as no response", async () => {
		stubFetch();

		await notifyUpstreamFailure({ status: "network", context: "NORAD ID 25544", streak: 3, durationMs: 15 * 60 * 1000, untilIso: "2026-11-19T20:15:00.000Z" });

		expect(sent[0]!.body.embeds![0]!.title).toContain("No response");
	});

	test("repeats of the same failure are throttled, a different one is not", async () => {
		stubFetch();

		await notifyUpstreamFailure({ status: 503, context: 'group "active"', streak: 1, durationMs: 1000, untilIso: "x" });
		await notifyUpstreamFailure({ status: 503, context: 'group "active"', streak: 1, durationMs: 1000, untilIso: "x" });
		expect(sent).toHaveLength(1);

		await notifyUpstreamFailure({ status: "network", context: 'group "active"', streak: 2, durationMs: 1000, untilIso: "x" });
		expect(sent).toHaveLength(2);
	});

	test("sends one recovery message after an alert, and none without a preceding alert", async () => {
		stubFetch();

		await notifyUpstreamRecovered(2);
		expect(sent).toHaveLength(0);

		await notifyUpstreamFailure({ status: 503, context: 'group "active"', streak: 1, durationMs: 1000, untilIso: "x" });
		await notifyUpstreamRecovered(2);
		await notifyUpstreamRecovered(2);

		expect(sent).toHaveLength(2);
		expect(sent[1]!.body.embeds![0]!.title).toContain("recovered");
		expect(sent[1]!.body.embeds![0]!.color).toBe(0x57f287);
	});

	test("a rejected webhook does not throw", async () => {
		stubFetch(400);

		await expect(notifyUpstreamFailure({ status: 503, context: "x", streak: 1, durationMs: 1000, untilIso: "x" })).resolves.toBeUndefined();
	});
});
