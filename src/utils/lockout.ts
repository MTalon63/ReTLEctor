import kv from "./kv";
import log from "./logger";
import config from "./config";
import { notifyUpstreamFailure, notifyUpstreamRecovered } from "./alerts";

export const LOCKOUT_KEY = "celestrak_lockout_until";
export const FAILURE_STREAK_KEY = "celestrak_failure_streak";
const SERVER_STREAK_KEY = "celestrak_server_error_streak";
const NETWORK_STREAK_KEY = "celestrak_network_streak";

export type FailureKind = number | "network";

const NETWORK_BACKOFF_MS = [5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000, 6 * 60 * 60 * 1000, 24 * 60 * 60 * 1000];
const SERVER_ERROR_BACKOFF_MS = [15 * 60 * 1000, 30 * 60 * 1000, 60 * 60 * 1000, 2 * 60 * 60 * 1000];

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

export function formatRemainingLockout(lockout: { untilMs?: number }): string {
	return formatLockoutDuration(Math.max(0, (lockout.untilMs ?? Date.now()) - Date.now()));
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

	await kv.delete(SERVER_STREAK_KEY);
	await kv.delete(NETWORK_STREAK_KEY);

	if (streak) {
		await kv.delete(FAILURE_STREAK_KEY);
		void notifyUpstreamRecovered(streak);
	}
}

// Per-class ladders: a transient 500 must not inherit a block-sized pause.
function streakKeyFor(status: FailureKind): string {
	if (status === "network") return NETWORK_STREAK_KEY;
	if (status >= 500) return SERVER_STREAK_KEY;
	return FAILURE_STREAK_KEY;
}

function lockoutDurationFor(status: FailureKind, streak: number): number {
	if (status === "network") {
		return NETWORK_BACKOFF_MS[Math.min(streak, NETWORK_BACKOFF_MS.length) - 1]!;
	}
	if (status >= 500) {
		return SERVER_ERROR_BACKOFF_MS[Math.min(streak, SERVER_ERROR_BACKOFF_MS.length) - 1]!;
	}
	return Math.min(config.celestrakLockDuration * 2 ** (streak - 1), config.maxFailureBackoffMs);
}

export async function triggerCelestrakLockout(status: FailureKind, context: string): Promise<number | null> {
	if (status === 404) {
		log.debug(`Celestrak returned HTTP 404 during ${context}. Skipping lockout.`);
		return null;
	}

	const streakKey = streakKeyFor(status);
	const streak = (((await kv.get(streakKey)) as number | null) || 0) + 1;
	await kv.set(streakKey, streak);

	const duration = lockoutDurationFor(status, streak);
	const lockoutUntil = Date.now() + duration;
	await kv.set(LOCKOUT_KEY, lockoutUntil);

	const isoStr = new Date(lockoutUntil).toISOString();
	const reason = status === "network" ? "Network error/timeout" : `HTTP ${status}`;
	log.error(
		`${reason} during ${context} (consecutive failures: ${streak}). Initiating ${formatLockoutDuration(duration)} lockout until ${isoStr}. No further requests will be sent to Celestrak during this period.`,
	);

	void notifyUpstreamFailure({ status, context, streak, durationMs: duration, untilIso: isoStr });
	return lockoutUntil;
}
