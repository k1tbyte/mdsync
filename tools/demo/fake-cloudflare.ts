/**
 * A stand-in for Cloudflare in the wizard demo, so a take can deploy a relay without an account: it answers
 * what the plugin sends to the Cloudflare API, to the new worker's address and to the R2 endpoint (forwarded to
 * a local S3). Requests to any other host go out as they would.
 *
 * Obsidian's `requestUrl` is reachable only through the module a plugin requires, so `routeRequests` rewrites
 * the vault's copy of the bundle to read it from `window.__demoRequest` first.
 */

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "playwright-core";

import { sleep } from "../../tests/e2e/harness";

const ACCOUNT = "9f2c1d7a4b6e8035a1c2d4e6f8a0b3c5";
const TOKEN_ID = "6b1d0e47a39c52f8d4e1b7a03c68f925";
const SUBDOMAIN = "alex-notes";
const R2_BUCKET = "mdsync-vaults";
/** The first answers of a new workers.dev address are errors, as they are in the first minute. */
const SILENT_STATUS_POLLS = 1;

interface Wire {
	url: string;
	method: string;
	headers: Record<string, string>;
	/** Base64, absent for no body. */
	body?: string;
}

interface Answer {
	status: number;
	headers?: Record<string, string>;
	body: Buffer | string;
}

export interface LocalS3 {
	url: string;
	bucket: string;
}

/** Slows each step to a pace the take can show; the real calls take about a second each too. */
export interface Pacing {
	bucket: number;
	subdomain: number;
	namespace: number;
	assets: number;
	worker: number;
	route: number;
}

const FILMED: Pacing = {
	bucket: 1100,
	subdomain: 900,
	namespace: 900,
	assets: 1000,
	worker: 1300,
	route: 800,
};

/** Points the vault's copy of the plugin at `window.__demoRequest`; the plugin must be reloaded to pick it up. */
export function routeRequests(vault: string): void {
	const file = join(vault, ".obsidian/plugins/mdsync/main.js");
	const hook =
		"var __route=(real)=>{window.__realRequestUrl??=real.requestUrl;return Object.create(real,{requestUrl:{get:()=>window.__demoRequest??real.requestUrl}})};";
	const code = readFileSync(file, "utf8")
		.replace('"use strict";', `"use strict";${hook}`)
		.replaceAll('require("obsidian")', '__route(require("obsidian"))');
	writeFileSync(file, code);
}

export async function fakeCloudflare(
	page: Page,
	s3: LocalS3,
	pacing: Pacing = FILMED,
): Promise<void> {
	let version = "";
	let silent = SILENT_STATUS_POLLS;

	const json = (result: unknown): Answer => ({
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ success: true, errors: [], result }),
	});

	const api = async (
		{ method, url, body }: Wire,
		path: string,
	): Promise<Answer> => {
		const at = (pattern: RegExp) => pattern.test(path);
		if (method === "GET" && at(/^\/accounts\?/)) {
			return json([{ id: ACCOUNT, name: "Personal" }]);
		}
		if (method === "GET" && at(/\/tokens\/verify$/)) {
			return json({ id: TOKEN_ID, status: "active" });
		}
		if (method === "POST" && at(/\/r2\/buckets$/)) {
			await sleep(pacing.bucket);
			return json({ name: R2_BUCKET });
		}
		if (method === "GET" && at(/\/workers\/subdomain$/)) {
			await sleep(pacing.subdomain);
			return json({ subdomain: SUBDOMAIN });
		}
		if (method === "GET" && at(/\/workers\/scripts$/)) return json([]);
		if (method === "GET" && at(/\/kv\/namespaces\?/)) return json([]);
		if (method === "POST" && at(/\/kv\/namespaces$/)) {
			await sleep(pacing.namespace);
			return json({ id: randomBytes(16).toString("hex") });
		}
		if (method === "POST" && at(/\/assets-upload-session$/)) {
			await sleep(pacing.assets);
			// Nothing to upload: the session token is the completion token.
			return json({ jwt: "session", buckets: [] });
		}
		if (method === "PUT" && at(/\/workers\/scripts\/[^/]+$/)) {
			await sleep(pacing.worker);
			const sent = Buffer.from(body ?? "", "base64").toString("utf8");
			version = /"name":"RELAY_VERSION","text":"([^"]+)"/.exec(sent)?.[1] ?? "";
			return json({});
		}
		if (method === "POST" && at(/\/workers\/scripts\/[^/]+\/subdomain$/)) {
			await sleep(pacing.route);
			return json({ enabled: true });
		}
		throw new Error(`fake Cloudflare has no ${method} ${url}`);
	};

	const relay = (path: string): Answer => {
		if (path !== "/status") return { status: 404, body: "" };
		if (silent > 0) {
			silent--;
			return { status: 522, body: "" };
		}
		return {
			status: 200,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ version }),
		};
	};

	const storage = async (wire: Wire, url: URL): Promise<Answer> => {
		const [, , ...key] = url.pathname.split("/");
		const target = `${s3.url}/${s3.bucket}/${key.join("/")}${url.search}`;
		const sent = { ...wire.headers };
		delete sent.Host;
		delete sent.host;
		const res = await fetch(target, {
			method: wire.method,
			headers: sent,
			body: wire.body ? Buffer.from(wire.body, "base64") : undefined,
		});
		const headers: Record<string, string> = {};
		res.headers.forEach((value, name) => {
			headers[name] = value;
		});
		return {
			status: res.status,
			headers,
			body: Buffer.from(await res.arrayBuffer()),
		};
	};

	const answer = async (wire: Wire): Promise<Answer> => {
		const url = new URL(wire.url);
		if (url.host === "api.cloudflare.com") {
			return api(wire, url.pathname.replace("/client/v4", "") + url.search);
		}
		if (url.host.endsWith(".workers.dev")) return relay(url.pathname);
		return storage(wire, url);
	};

	await page.exposeFunction("demoHttp", async (wire: Wire) => {
		const result = await answer(wire).catch((err: unknown) => ({
			status: 599,
			body: String(err),
		}));
		const body =
			typeof result.body === "string" ? Buffer.from(result.body) : result.body;
		return {
			status: result.status,
			headers: "headers" in result ? (result.headers ?? {}) : {},
			body: body.toString("base64"),
		};
	});

	await page.evaluate(() => {
		type Reply = {
			status: number;
			headers: Record<string, string>;
			body: string;
		};
		const win = window as unknown as {
			__realRequestUrl: (arg: unknown) => unknown;
			__demoRequest: (arg: unknown) => unknown;
			demoHttp: (wire: unknown) => Promise<Reply>;
		};
		const fake =
			/^(api\.cloudflare\.com|[^.]+\.[^.]+\.workers\.dev|[^.]+\.r2\.cloudflarestorage\.com)$/;
		win.__demoRequest = async (arg: unknown) => {
			const request = (typeof arg === "string" ? { url: arg } : arg) as {
				url: string;
				method?: string;
				headers?: Record<string, string>;
				body?: string | ArrayBuffer;
			};
			if (!fake.test(new URL(request.url).host)) {
				return win.__realRequestUrl(arg);
			}
			let body: string | undefined;
			if (typeof request.body === "string") {
				body = btoa(unescape(encodeURIComponent(request.body)));
			} else if (request.body) {
				let binary = "";
				for (const byte of new Uint8Array(request.body)) {
					binary += String.fromCharCode(byte);
				}
				body = btoa(binary);
			}
			const res = await win.demoHttp({
				url: request.url,
				method: request.method ?? "GET",
				headers: request.headers ?? {},
				body,
			});
			const bytes = Uint8Array.from(atob(res.body), (c) => c.charCodeAt(0));
			const text = new TextDecoder().decode(bytes);
			return {
				status: res.status,
				headers: res.headers,
				arrayBuffer: bytes.buffer,
				text,
				get json() {
					return JSON.parse(text);
				},
			};
		};
	});
}
