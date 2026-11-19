import config from "./config";
import log from "./logger";
import { type FailureKind } from "./lockout";
import { version } from "../../package.json";

const COLOR_BLOCKED = 0xed4245;
const COLOR_SERVER = 0xfaa61a;
const COLOR_CLIENT = 0xfaa61a;

let lastSentAt = 0;
let failureAlerted = false;
const lastSentByKey = new Map<string, number>();

function throttled(key: string): boolean {
	const now = Date.now();
	if (now - lastSentAt < config.alertMinIntervalMs) return true;

	const last = lastSentByKey.get(key) ?? 0;
	if (now - last < config.alertThrottleMs) return true;

	lastSentByKey.set(key, now);
	lastSentAt = now;
	return false;
}

function colorFor(status: FailureKind): number {
	if (status === "network") return COLOR_BLOCKED;
	if (status === "not-found") return COLOR_CLIENT;
	if (status === 403 || status === 429) return COLOR_BLOCKED;
	if (status >= 500) return COLOR_SERVER;
	return COLOR_CLIENT;
}

function labelFor(status: FailureKind): string {
	if (status === "network") return "No response (timeout / connection refused)";
	if (status === "not-found") return "Clients replaying dead catalog IDs (repeated 404s)";
	return `HTTP ${status}`;
}

async function post(payload: unknown): Promise<void> {
	if (!config.discordWebhookUrl) return;

	try {
		const response = await fetch(config.discordWebhookUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(config.upstreamTimeoutMs),
		});

		if (!response.ok) {
			log.warn(`Discord webhook returned ${response.status} ${response.statusText}.`);
		}
	} catch (err) {
		log.warn(`Discord webhook failed: ${err}`);
	}
}

export interface UpstreamFailureAlert {
	status: FailureKind;
	context: string;
	streak: number;
	durationMs: number;
	untilIso: string;
}

export async function notifyUpstreamFailure(alert: UpstreamFailureAlert): Promise<void> {
	if (!config.discordWebhookUrl) return;
	if (throttled(String(alert.status))) {
		log.debug(`Upstream alert for ${alert.context} suppressed by throttle.`);
		return;
	}

	await post({
		username: config.appName,
		embeds: [
			{
				title: `Celestrak: ${labelFor(alert.status)} during ${alert.context}`,
				color: colorFor(alert.status),
				fields: [
					{ name: "Upstream", value: labelFor(alert.status), inline: true },
					{ name: "Consecutive failures", value: String(alert.streak), inline: true },
					{ name: "Paused for", value: `${formatDuration(alert.durationMs)} (until ${alert.untilIso})`, inline: false },
				],
				footer: { text: `${config.appName} ${version}` },
				timestamp: new Date().toISOString(),
			},
		],
	});

	failureAlerted = true;
}

export async function notifyUpstreamRecovered(streak: number): Promise<void> {
	if (!config.discordWebhookUrl || !failureAlerted) return;
	failureAlerted = false;

	await post({
		username: config.appName,
		embeds: [
			{
				title: "Celestrak: recovered",
				description: `Upstream is answering again after ${streak} consecutive failure${streak === 1 ? "" : "s"}. Caching resumed.`,
				color: 0x57f287,
				footer: { text: `${config.appName} ${version}` },
				timestamp: new Date().toISOString(),
			},
		],
	});
}

function formatDuration(ms: number): string {
	const minutes = Math.round(ms / (60 * 1000));
	if (minutes < 60) return `${minutes}m`;
	const hours = ms / (60 * 60 * 1000);

	return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

export function resetAlertState(): void {
	lastSentAt = 0;
	failureAlerted = false;
	lastSentByKey.clear();
}
