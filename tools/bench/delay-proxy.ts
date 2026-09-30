/** A forwarding proxy that waits before each request: a stand-in for network round-trip time. */

import { createServer, request } from "node:http";

const KEEP_ALIVE_MS = 60_000;
const HOP_BY_HOP = new Set(["connection", "keep-alive"]);

export interface DelayProxy {
	url: string;
	setDelay(ms: number): void;
	stop(): void;
}

export async function startDelayProxy(
	port: number,
	target: string,
): Promise<DelayProxy> {
	let delayMs = 0;
	const { hostname, port: targetPort } = new URL(target);
	const server = createServer((req, res) => {
		setTimeout(() => {
			const upstream = request(
				{
					host: hostname,
					port: targetPort,
					path: req.url,
					method: req.method,
					headers: req.headers,
					agent: false,
				},
				(answer) => {
					const headers = Object.entries(answer.headers).filter(
						([name]) => !HOP_BY_HOP.has(name),
					);
					res.writeHead(answer.statusCode ?? 502, Object.fromEntries(headers));
					answer.pipe(res);
				},
			);
			upstream.on("error", (error) => {
				console.error(`proxy to ${target}: ${error.message}`);
				res.destroy();
			});
			req.pipe(upstream);
		}, delayMs);
	});
	server.keepAliveTimeout = KEEP_ALIVE_MS;
	await new Promise<void>((resolve) => server.listen(port, resolve));
	return {
		url: `http://127.0.0.1:${port}`,
		setDelay: (ms) => {
			delayMs = ms;
		},
		stop: () => {
			server.close();
			server.closeAllConnections();
		},
	};
}
