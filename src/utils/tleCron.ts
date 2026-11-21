import kv from "./kv";
import config from "./config";
import log from "./logger";
import fetchTle from "./tleFetcher";
import { isCelestrakLockedOut, formatLockoutDuration } from "./lockout";
import { isDerivedGroup } from "./derivedGroup";

export function getRandomJitter(maxJitterMs: number): number {
	if (maxJitterMs <= 0) return 0;
	return Math.floor(Math.random() * maxJitterMs);
}

async function checkAndUpdateTles(warm = false): Promise<void> {
	const lockout = await isCelestrakLockedOut();
	if (lockout.locked) {
		log.warn(
			`Celestrak is in ${formatLockoutDuration(lockout.untilMs ? lockout.untilMs - Date.now() : undefined)} lockout (until ${lockout.untilIso}). Skipping background cron updates.`,
		);
		return;
	}

	log.debug(warm ? "Warming cached groups on startup..." : "Running scheduled orbital data update check...");
	const now = Date.now();
	let fetched = 0;

	for (const group of config.allowedGroups) {
		if (isDerivedGroup(group)) {
			continue;
		}

		const queryType = config.specialGroups.includes(group) ? "SPECIAL" : "GROUP";

		const tsKey = `${group}_timestamp_csv`;
		const timestamp = (await kv.get(tsKey)) as number | null;

		const isPrimaryGroup = group === "active";

		if (!timestamp) {
			if (!isPrimaryGroup && !warm) {
				continue;
			}
			log.info(`Group "${group}" has no cached data. Fetching...`);
		} else {
			const refreshThreshold = group === "active" ? config.cacheActiveDuration : config.cacheDuration;
			const age = now - timestamp;
			if (age < refreshThreshold) {
				continue;
			}
			const ageHours = (age / (60 * 60 * 1000)).toFixed(1);
			log.info(`Group "${group}" orbital data age (${ageHours}h) exceeds cache duration. Refreshing...`);
		}

		try {
			await fetchTle(group, "csv", queryType);
			fetched++;
		} catch (err) {
			log.error(`Background cron failed to update group "${group}": ${err}`);
			if ((await isCelestrakLockedOut()).locked) {
				log.warn(`Stopping this update pass early - Celestrak lockout is in effect.`);
				return;
			}
		}

		const interFetchDelay = 3000 + Math.floor(Math.random() * 5000);
		await new Promise((resolve) => setTimeout(resolve, interFetchDelay));
	}

	if (warm) log.info(`Warm start finished: ${fetched} group(s) refreshed.`);
}

function scheduleNextCheck(): void {
	const jitterMs = getRandomJitter(config.cronJitter);
	const nextDelayMs = config.cronInterval + jitterMs;
	log.debug(
		`Next orbital data cron update check in ${(nextDelayMs / 1000).toFixed(0)}s (including ${(jitterMs / 1000).toFixed(0)}s random jitter).`,
	);

	setTimeout(async () => {
		try {
			await checkAndUpdateTles();
		} catch (err) {
			log.error(`Periodic orbital data background check error: ${err}`);
		} finally {
			scheduleNextCheck();
		}
	}, nextDelayMs);
}

export function startTleCron(): void {
	const maxAgeDays = (config.maxStorageAge / (24 * 60 * 60 * 1000)).toFixed(1);
	log.info(
		`Starting orbital data background updater (interval: ${config.cronInterval / 1000}s, max jitter: ${config.cronJitter / 1000}s, max age: ${maxAgeDays} days, warm start: ${config.warmOnStart}).`,
	);

	checkAndUpdateTles(config.warmOnStart).catch((err) => {
		log.error(`Initial orbital data background check error: ${err}`);
	});

	scheduleNextCheck();
}
