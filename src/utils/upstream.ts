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

		const controller = new AbortController();
		const headerTimer = setTimeout(() => controller.abort(new Error("upstream header timeout")), config.upstreamTimeoutMs);

		try {
			const response = await fetch(url, { ...init, signal: controller.signal });
			return withStallWatchdog(response, controller);
		} finally {
			clearTimeout(headerTimer);
			lastFetchFinished = Date.now();
		}
	};

	const result = fetchChain.then(run, run);
	fetchChain = result.catch(() => undefined);
	return result;
}

function withStallWatchdog(response: Response, controller: AbortController): Response {
	if (!response.body) return response;

	const reader = response.body.getReader();
	let stallTimer: ReturnType<typeof setTimeout> | undefined;

	const disarm = () => {
		if (stallTimer) clearTimeout(stallTimer);
		stallTimer = undefined;
	};
	const arm = () => {
		disarm();
		stallTimer = setTimeout(() => controller.abort(new Error("upstream stalled")), config.upstreamStallMs);
	};

	arm();

	const body = new ReadableStream<Uint8Array>({
		async pull(stream) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					disarm();
					stream.close();
					return;
				}
				arm();
				stream.enqueue(value);
			} catch (err) {
				disarm();
				stream.error(err);
			}
		},
		cancel(reason) {
			disarm();
			return reader.cancel(reason);
		},
	});

	return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function resetUpstreamState(): void {
	inFlight.clear();
	criticalChain = Promise.resolve();
	fetchChain = Promise.resolve();
	lastFetchFinished = 0;
}
