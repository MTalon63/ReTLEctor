import { Elysia } from "elysia";

import kv from "./kv";
import log from "./logger";
import config from "./config";

type ClientInfo = { count: number; startTime: number };

// Trust Cloudflare only when it signed the request, otherwise the hop our own proxy appended.
function clientIp(ctx: { request: Request; server?: unknown }): string {
	const headers = ctx.request.headers;
	const cfIp = headers.get("cf-ray") ? headers.get("cf-connecting-ip") : null;
	if (cfIp) return cfIp.trim();

	const forwarded = headers.get("x-forwarded-for")?.split(",").pop()?.trim();
	if (forwarded) return forwarded;

	const socket = (ctx.server as { requestIP?: (req: Request) => { address?: string } | null } | undefined)?.requestIP?.(ctx.request);
	return socket?.address || "unknown";
}

function limitHeaders(maxRequests: number, count: number, startTime: number, windowSize: number) {
	return {
		"X-RateLimit-Limit": String(maxRequests),
		"X-RateLimit-Remaining": String(Math.max(0, maxRequests - count)),
		"X-RateLimit-Reset": String(Math.ceil((startTime + windowSize) / 1000)),
	};
}

const limiter = new Elysia({ name: "rate-limiter" }).onRequest(async (ctx) => {
	const ip = clientIp(ctx);
	const key = `rate_limit:${ip}`;
	const now = Date.now();
	const windowSize = config.rateLimitWindow;
	const maxRequests = config.rateLimitMaxRequests;

	let clientInfo = (await kv.get(key)) as ClientInfo | undefined;
	if (!clientInfo) {
		clientInfo = { count: 1, startTime: now };
		await kv.set(key, clientInfo, windowSize);
		Object.assign(ctx.set.headers, limitHeaders(maxRequests, clientInfo.count, clientInfo.startTime, windowSize));
		return;
	}

	if (now - clientInfo.startTime >= windowSize) {
		clientInfo = { count: 1, startTime: now };
		await kv.set(key, clientInfo, windowSize);
		Object.assign(ctx.set.headers, limitHeaders(maxRequests, clientInfo.count, clientInfo.startTime, windowSize));
		return;
	}

	clientInfo.count++;

	if (clientInfo.count > maxRequests) {
		log.debug(`Rate limit exceeded for IP ${ip}`);
		const retryAfterSeconds = Math.max(1, Math.ceil((clientInfo.startTime + windowSize - now) / 1000));
		return new Response("Too Many Requests", {
			status: 429,
			headers: {
				...limitHeaders(maxRequests, 0, clientInfo.startTime, windowSize),
				"Retry-After": String(retryAfterSeconds),
			},
		});
	}

	Object.assign(ctx.set.headers, limitHeaders(maxRequests, clientInfo.count, clientInfo.startTime, windowSize));
	const remainingTtl = Math.max(1, windowSize - (now - clientInfo.startTime));
	await kv.set(key, clientInfo, remainingTtl);
});

export default limiter;
