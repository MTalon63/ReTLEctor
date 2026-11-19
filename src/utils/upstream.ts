import config from "./config";

const inFlight = new Map<string, Promise<unknown>>();

export function coalesce<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const existing = inFlight.get(key) as Promise<T> | undefined;
	if (existing) return existing;

	const promise = fn().finally(() => {
		if (inFlight.get(key) === promise) inFlight.delete(key);
	});
	inFlight.set(key, promise);
	return promise;
}

// Read-modify-write sections on the KV counters.
let criticalChain: Promise<unknown> = Promise.resolve();

export function serialize<T>(fn: () => Promise<T>): Promise<T> {
	const result = criticalChain.then(fn, fn);
	criticalChain = result.catch(() => undefined);
	return result;
}

// Celestrak firewalls IPs that retry after a non-200: one connection at a time, spaced, with a timeout.
let fetchChain: Promise<unknown> = Promise.resolve();
let lastFetchFinished = 0;

export function upstreamFetch(url: string, init: RequestInit = {}): Promise<Response> {
	const run = async () => {
		const wait = lastFetchFinished + config.upstreamMinSpacingMs - Date.now();
		if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

		try {
			return await fetch(url, { ...init, signal: AbortSignal.timeout(config.upstreamTimeoutMs) });
		} finally {
			lastFetchFinished = Date.now();
		}
	};

	const result = fetchChain.then(run, run);
	fetchChain = result.catch(() => undefined);
	return result;
}

export function resetUpstreamState(): void {
	inFlight.clear();
	criticalChain = Promise.resolve();
	fetchChain = Promise.resolve();
	lastFetchFinished = 0;
}
