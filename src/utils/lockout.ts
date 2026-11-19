import kv from "./kv";
import log from "./logger";
import config from "./config";
import { notifyUpstreamFailure, notifyUpstreamRecovered } from "./alerts";

export const LOCKOUT_KEY = "celestrak_lockout_until";
export const FAILURE_STREAK_KEY = "celestrak_failure_streak";
export const NOT_FOUND_STREAK_KEY = "celestrak_404_streak";

const NETWORK_BACKOFF_MS = [5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000, 6 * 60 * 60 * 1000, 24 * 60 * 60 * 1000];

export function formatLockoutDuration(ms: number = config.celestrakLockDuration): string {
	const totalMinutes = Math.round(ms / (60 * 1000));
	if (totalMinutes < 60) {
		return `${totalMinutes}m`;
	}
	const hours = ms / (60 * 60 * 1000);
	if (Number.isInteger(hours)) {
		return `${hours}h`;
	}
	return `${hours.toFixed(1)}h`;
}

export async function isCelestrakLockedOut(): Promise<{ locked: boolean; untilIso?: string; untilMs?: number }> {
	const lockoutUntil = (await kv.get(LOCKOUT_KEY)) as number | null;
	if (!lockoutUntil) return { locked: false };

	const now = Date.now();
	if (now < lockoutUntil) {
		return {
			locked: true,
			untilIso: new Date(lockoutUntil).toISOString(),
			untilMs: lockoutUntil,
		};
	}

	await kv.delete(LOCKOUT_KEY);
	return { locked: false };
}

export async function getFailureStreak(): Promise<number> {
	return ((await kv.get(FAILURE_STREAK_KEY)) as number | null) || 0;
}

export async function clearCelestrakFailures(): Promise<void> {
	const streak = ((await kv.get(FAILURE_STREAK_KEY)) as number | null) || 0;

	if (streak) {
		await kv.delete(FAILURE_STREAK_KEY);
		void notifyUpstreamRecovered(streak);
	}
	if (((await kv.get(NOT_FOUND_STREAK_KEY)) as number | null) || 0) {
		await kv.delete(NOT_FOUND_STREAK_KEY);
	}
}

// A single 404 is a deorbited object; a run of them is a client replaying a dead catalog.
export async function noteNoradNotFound(context: string): Promise<void> {
	const streak = (((await kv.get(NOT_FOUND_STREAK_KEY)) as number | null) || 0) + 1;

	if (streak >= config.maxConsecutiveNotFound) {
		await kv.delete(NOT_FOUND_STREAK_KEY);
		await triggerCelestrakLockout("network", `${context} (${streak} consecutive 404s)`);
		return;
	}

	await kv.set(NOT_FOUND_STREAK_KEY, streak);
}

function lockoutDurationFor(status: number | "network", streak: number): number {
	if (status === "network") {
		return NETWORK_BACKOFF_MS[Math.min(streak, NETWORK_BACKOFF_MS.length) - 1]!;
	}
	return Math.min(config.celestrakLockDuration * 2 ** (streak - 1), config.maxFailureBackoffMs);
}

export async function triggerCelestrakLockout(status: number | "network", context: string): Promise<number | null> {
	if (status === 404) {
		log.debug(`Celestrak returned HTTP 404 during ${context}. Skipping lockout.`);
		return null;
	}

	const streak = (await getFailureStreak()) + 1;
	await kv.set(FAILURE_STREAK_KEY, streak);

	const duration = lockoutDurationFor(status, streak);
	const lockoutUntil = Date.now() + duration;
	await kv.set(LOCKOUT_KEY, lockoutUntil);

	const isoStr = new Date(lockoutUntil).toISOString();
	const reason = typeof status === "number" ? `HTTP ${status}` : "Network error/timeout";
	log.error(
		`${reason} during ${context} (consecutive failures: ${streak}). Initiating ${formatLockoutDuration(duration)} lockout until ${isoStr}. No further requests will be sent to Celestrak during this period.`,
	);

	void notifyUpstreamFailure({ status, context, streak, durationMs: duration, untilIso: isoStr });
	return lockoutUntil;
}
