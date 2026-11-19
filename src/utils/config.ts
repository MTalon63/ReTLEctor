import { version } from "../../package.json";

const contact = process.env.CONTACT_EMAIL || process.env.CONTACT_INFO || process.env.OPERATOR_CONTACT || null;

const demoNoradIds = new Set<number>([
	1361, 25415, 25982, 25989, 36037, 37846, 37847, 38771, 38857, 40128, 40129, 40544, 40545, 40890, 41174, 41175, 41549, 41550,
	41859, 41860, 41861, 41862, 43055, 43056, 43057, 43058, 43564, 43565, 43566, 43567, 43689, 47719, 49809, 49810, 59598, 59600,
	61182, 61183, 62256, 67160, 67162,
]);

function parseList(value: string | undefined): string[] {
	return value
		? value
				.split(",")
				.map((entry) => entry.trim())
				.filter(Boolean)
		: [];
}

// SPECIAL_GROUPS is fetched with SPECIAL= and allowed by itself.
export function resolveGroups(allowedEnv?: string, specialEnv?: string): { allowedGroups: string[]; specialGroups: string[] } {
	const specialGroups = parseList(specialEnv);
	const allowedGroups = Array.from(new Set(["active", "active-no-starlink", "demo", ...parseList(allowedEnv), ...specialGroups]));

	return { allowedGroups, specialGroups };
}

const groups = resolveGroups(process.env.ALLOWED_GROUPS, process.env.SPECIAL_GROUPS);

const config = {
	allowedGroups: groups.allowedGroups,
	specialGroups: groups.specialGroups,

	derivedGroups: {
		"active-no-starlink": {
			source: "active",
			filter: (name: string) => !name.toUpperCase().startsWith("STARLINK"),
		},
		demo: {
			source: "active",
			filter: (_name: string, noradId?: number) => noradId !== undefined && demoNoradIds.has(noradId),
		},
	} as const,
	formats: ["tle", "json", "csv", "kvn"] as const,
	logLevel: process.env.LOG_LEVEL || "info",
	port: process.env.PORT ? parseInt(process.env.PORT) : 3000,
	redisUri: process.env.REDIS_URI || null,
	kvFile: process.env.KV_FILE || "./data/kv.json",
	kvWriteDelay: process.env.KV_WRITE_DELAY ? parseInt(process.env.KV_WRITE_DELAY) : 100,
	kvBatchSize: process.env.KV_BATCH_SIZE ? parseInt(process.env.KV_BATCH_SIZE) : 100,
	lokiUri: process.env.LOKI_URI || null,
	lokiAuth: process.env.LOKI_AUTH || undefined,
	rateLimitWindow: process.env.RATE_LIMIT_WINDOW ? parseInt(process.env.RATE_LIMIT_WINDOW) * 1000 : 60 * 1000,
	rateLimitMaxRequests: process.env.RATE_LIMIT_MAX_REQUESTS ? parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) : 60,
	cacheDuration: process.env.CACHE_DURATION ? parseInt(process.env.CACHE_DURATION) * 1000 : 12 * 60 * 60 * 1000,
	cacheActiveDuration: process.env.CACHE_ACTIVE_DURATION ? parseInt(process.env.CACHE_ACTIVE_DURATION) * 1000 : 4 * 60 * 60 * 1000,
	cacheNoradDuration: process.env.CACHE_NORAD_DURATION ? parseInt(process.env.CACHE_NORAD_DURATION) * 1000 : 24 * 60 * 60 * 1000,
	cacheNotFoundDuration: process.env.CACHE_NOT_FOUND_DURATION ? parseInt(process.env.CACHE_NOT_FOUND_DURATION) * 1000 : 6 * 60 * 60 * 1000,
	maxStorageAge: process.env.MAX_STORAGE_AGE
		? parseInt(process.env.MAX_STORAGE_AGE) < 365
			? parseInt(process.env.MAX_STORAGE_AGE) * 24 * 60 * 60 * 1000
			: parseInt(process.env.MAX_STORAGE_AGE) * 1000
		: 14 * 24 * 60 * 60 * 1000,
	cronInterval: process.env.CRON_INTERVAL ? parseInt(process.env.CRON_INTERVAL) * 1000 : 60 * 60 * 1000,
	cronJitter: process.env.CRON_JITTER ? parseInt(process.env.CRON_JITTER) * 1000 : 15 * 60 * 1000,
	warmOnStart: process.env.WARM_ON_START === "1",
	celestrakUrl: process.env.CELESTRAK_URL || "https://celestrak.org/NORAD/elements/gp.php",
	spacetrackUser: process.env.SPACETRACK_USER || null,
	spacetrackPassword: process.env.SPACETRACK_PASS || null,
	spacetrackUrl: process.env.SPACETRACK_URL || "https://www.space-track.org",
	spacetrackMinSpacingMs: process.env.SPACETRACK_MIN_SPACING ? parseInt(process.env.SPACETRACK_MIN_SPACING) * 1000 : 2500,
	spacetrackMaxPerMinute: process.env.SPACETRACK_MAX_PER_MINUTE ? parseInt(process.env.SPACETRACK_MAX_PER_MINUTE) : 20,
	spacetrackMaxPerHour: process.env.SPACETRACK_MAX_PER_HOUR ? parseInt(process.env.SPACETRACK_MAX_PER_HOUR) : 250,
	spacetrackMaxAgeDays: process.env.SPACETRACK_MAX_AGE_DAYS ? parseInt(process.env.SPACETRACK_MAX_AGE_DAYS) : 30,
	upstreamTimeoutMs: process.env.UPSTREAM_TIMEOUT ? parseInt(process.env.UPSTREAM_TIMEOUT) * 1000 : 20 * 1000,
	upstreamMinSpacingMs: process.env.UPSTREAM_MIN_SPACING ? parseInt(process.env.UPSTREAM_MIN_SPACING) * 1000 : 1000,
	maxFailureBackoffMs: process.env.MAX_FAILURE_BACKOFF ? parseInt(process.env.MAX_FAILURE_BACKOFF) * 1000 : 48 * 60 * 60 * 1000,
	discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || null,
	alertThrottleMs: process.env.ALERT_THROTTLE ? parseInt(process.env.ALERT_THROTTLE) * 1000 : 5 * 60 * 1000,
	alertMinIntervalMs: process.env.ALERT_MIN_INTERVAL ? parseInt(process.env.ALERT_MIN_INTERVAL) * 1000 : 30 * 1000,
	siteUrl: process.env.SITE_URL || "",
	githubUrl: process.env.GITHUB_URL || "https://github.com/MrTalon63/ReTLEctor",
	appName: process.env.APP_NAME || "ReTLEctor",
	staticCacheMaxAge: process.env.STATIC_CACHE_MAX_AGE ? parseInt(process.env.STATIC_CACHE_MAX_AGE) : 86400,
	celestrakLockDuration:
		process.env.CELESTRAK_LOCK_DURATION || process.env.CELESTRACK_LOCK_DURATION
			? parseInt(process.env.CELESTRAK_LOCK_DURATION || process.env.CELESTRACK_LOCK_DURATION!) * 1000
			: 12 * 60 * 60 * 1000,
	contactInfo: contact,
	userAgent: contact
		? `ReTLEctor/${version} (${contact}; +${process.env.GITHUB_URL || "https://github.com/MrTalon63/ReTLEctor"})`
		: `ReTLEctor/${version} (unconfigured-contact; +${process.env.GITHUB_URL || "https://github.com/MrTalon63/ReTLEctor"})`,
};

export default config;
