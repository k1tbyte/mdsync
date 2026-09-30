import { deriveChannelGrant, OWNER } from "@obsync/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { grantFor } from "../../src/hub/access";
import { HUB_ADMISSION_HEADER } from "../../src/hub/durable-object";
import worker, { type Env } from "../../src/index";
import { fingerprint } from "../../src/secret";
import { FakeKV } from "../helpers/fake-kv";
import { memorySql } from "../helpers/memory-sql";

const SECRET = "deployment-secret";
const VAULT = "s3|bucket/prefix";
const SHARE = "obsync-share-share1";
const PARTICIPANT_TOKEN = "p".repeat(43);
const VIEWER_TOKEN = "v".repeat(43);

interface HubCalls {
	headers: string[];
	admissions: unknown[];
	signals: [string, string][];
}

/** `secret: null` models a deployment that left RELAY_SECRET unset. */
function makeEnv(kv = new FakeKV(), secret: string | null = SECRET) {
	const calls: HubCalls = { headers: [], admissions: [], signals: [] };
	const hub = {
		idFromName: (name: string) => ({ name }),
		get: () => ({
			fetch: async (request: Request) => {
				const header = request.headers.get(HUB_ADMISSION_HEADER) ?? "null";
				calls.headers.push(header);
				calls.admissions.push(JSON.parse(header));
				return new Response("hub");
			},
			signal: async (channel: string, device: string) => {
				calls.signals.push([channel, device]);
			},
		}),
	};
	const env = {
		SHARE_TOKENS: kv,
		HUB: hub,
		...(secret === null ? {} : { RELAY_SECRET: secret }),
	} as unknown as Env;
	return { env, calls };
}

async function shareKv(): Promise<FakeKV> {
	const kv = new FakeKV();
	await kv.put(
		`tok:${PARTICIPANT_TOKEN}`,
		JSON.stringify({ shareId: "share1", participantId: "p1", label: "Alex" }),
	);
	await kv.put(
		`tok:${VIEWER_TOKEN}`,
		JSON.stringify({
			shareId: "share1",
			participantId: "p2",
			role: "ro",
			label: "x".repeat(100),
		}),
	);
	// A token is live while its participant's pointer names it.
	await kv.put("pt:share1:p1", PARTICIPANT_TOKEN);
	await kv.put("pt:share1:p2", VIEWER_TOKEN);
	return kv;
}

function call(path: string, env: Env, init?: RequestInit): Promise<Response> {
	return worker.fetch(
		new Request(`https://obsync-relay.example.workers.dev${path}`, init),
		env,
		{} as ExecutionContext,
	);
}

function hubPath(pairs: [string, string][], device = "laptop"): string {
	const query = new URLSearchParams();
	for (const [channel, token] of pairs) {
		query.append("c", channel);
		query.append("t", token);
	}
	query.set("d", device);
	return `/hub?${query}`;
}

describe("grants", () => {
	it("accepts the grant derived for this channel as the owner", async () => {
		const { env } = makeEnv();
		const token = await deriveChannelGrant(SECRET, VAULT);

		expect(await grantFor(env, VAULT, token)).toEqual({
			channel: VAULT,
			grant: await fingerprint(token),
			who: OWNER,
		});
	});

	it("refuses the secret itself, another channel's grant, or no token", async () => {
		const { env } = makeEnv();
		const elsewhere = await deriveChannelGrant(SECRET, "someone-elses");
		for (const token of [SECRET, elsewhere, ""]) {
			expect(await grantFor(env, VAULT, token), token).toBeNull();
		}
	});

	it("refuses an owner grant past its expiry or minted too far ahead", async () => {
		const { env } = makeEnv();
		const now = Math.floor(Date.now() / 1000);
		const expired = await deriveChannelGrant(SECRET, VAULT, now - 1);
		const ahead = await deriveChannelGrant(SECRET, VAULT, now + 3 * 86_400);
		const forged = `${now + 3600}.${(await deriveChannelGrant(SECRET, VAULT)).split(".")[1]}`;
		for (const token of [expired, ahead, forged]) {
			expect(await grantFor(env, VAULT, token), token).toBeNull();
		}
	});

	it("fails closed when no secret is configured", async () => {
		const { env } = makeEnv(new FakeKV(), null);
		const token = await deriveChannelGrant(SECRET, VAULT);
		expect(await grantFor(env, VAULT, token)).toBeNull();
	});

	it("opens a share channel to a live token of that share only, as its participant", async () => {
		const { env } = makeEnv(await shareKv());

		expect(await grantFor(env, SHARE, PARTICIPANT_TOKEN)).toMatchObject({
			channel: SHARE,
			who: "p1",
			name: "Alex",
		});
		expect(
			await grantFor(env, "obsync-share-share2", PARTICIPANT_TOKEN),
		).toBeNull();
		expect(await grantFor(env, VAULT, PARTICIPANT_TOKEN)).toBeNull();
		expect(await grantFor(env, SHARE, VIEWER_TOKEN)).toMatchObject({
			who: "p2",
			readOnly: true,
			name: "x".repeat(64),
		});
	});

	it("refuses an oversized token before it reaches KV", async () => {
		const kv = new FakeKV();
		const get = vi.spyOn(kv, "get");

		expect(await grantFor(makeEnv(kv).env, SHARE, "x".repeat(600))).toBeNull();
		expect(get).not.toHaveBeenCalled();
	});

	it("refuses a token that cannot be a share token before it reaches KV", async () => {
		const kv = new FakeKV();
		const get = vi.spyOn(kv, "get");
		const { env } = makeEnv(kv);
		const malformed = [
			"x",
			"participant",
			"p".repeat(42),
			"p".repeat(44),
			`${"p".repeat(42)}=`,
			`${"p".repeat(42)}/`,
		];

		for (const token of malformed) {
			expect(await grantFor(env, SHARE, token), token).toBeNull();
		}
		expect(get).not.toHaveBeenCalled();
	});

	it("never keeps the token itself in the grant", async () => {
		const { env } = makeEnv(await shareKv());
		const grant = await grantFor(env, SHARE, PARTICIPANT_TOKEN);
		expect(JSON.stringify(grant)).not.toContain(PARTICIPANT_TOKEN);
	});
});

describe("hub routing", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("admits each granted channel at its slot and refuses the rest", async () => {
		const { env, calls } = makeEnv(await shareKv());
		const vault = await deriveChannelGrant(SECRET, VAULT);

		const response = await call(
			hubPath([
				[VAULT, vault],
				[SHARE, "r".repeat(43)],
				[VAULT, vault],
			]),
			env,
		);

		expect(await response.text()).toBe("hub");
		expect(calls.admissions).toEqual([
			{
				device: "laptop",
				slots: [
					{ channel: VAULT, grant: await fingerprint(vault), who: OWNER },
					null,
					null,
				],
			},
		]);
	});

	it("hands the hub a name beyond ASCII in an ASCII header", async () => {
		const kv = await shareKv();
		await kv.put(
			`tok:${PARTICIPANT_TOKEN}`,
			JSON.stringify({
				shareId: "share1",
				participantId: "p1",
				label: "Łukasz 😀",
			}),
		);
		const { env, calls } = makeEnv(kv);

		await call(hubPath([[SHARE, PARTICIPANT_TOKEN]]), env);

		expect(calls.headers[0]).toMatch(/^[\x20-\x7e]+$/);
		expect(calls.admissions).toMatchObject([
			{ slots: [{ name: "Łukasz 😀" }] },
		]);
	});

	it("answers a request with no valid grant without waking the hub", async () => {
		const { env, calls } = makeEnv();

		const response = await call(hubPath([[VAULT, "x"]]), env);

		expect(response.status).toBe(401);
		expect(calls.admissions).toEqual([]);
	});

	it("closes an unauthorised socket with the code the client stops on", async () => {
		const server = { accept: vi.fn(), close: vi.fn() };
		vi.stubGlobal(
			"WebSocketPair",
			class {
				0 = {};
				1 = server;
			},
		);
		// Node's Response refuses status 101, which workerd uses for upgrades.
		vi.stubGlobal(
			"Response",
			class extends Response {
				constructor(body: BodyInit | null, init?: ResponseInit) {
					super(body, init?.status === 101 ? { status: 200 } : init);
				}
			},
		);

		await call(hubPath([[VAULT, "x"]]), makeEnv().env, {
			headers: { Upgrade: "websocket" },
		});

		expect(server.accept).toHaveBeenCalledOnce();
		expect(server.close).toHaveBeenCalledWith(4001, "Unauthorized");
	});

	it("signals a channel over HTTP for a device whose socket is down", async () => {
		const { env, calls } = makeEnv();
		const token = await deriveChannelGrant(SECRET, VAULT);
		const query = new URLSearchParams({ c: VAULT, t: token, d: "laptop" });

		const response = await call(`/hub/signal?${query}`, env, {
			method: "POST",
		});

		expect(response.status).toBe(200);
		expect(calls.signals).toEqual([[VAULT, "laptop"]]);
	});

	it("refuses an HTTP signal without a grant, or by GET", async () => {
		const { env, calls } = makeEnv();
		const token = await deriveChannelGrant(SECRET, VAULT);

		const unauthorised = new URLSearchParams({ c: VAULT, t: "x" });
		expect(
			(await call(`/hub/signal?${unauthorised}`, env, { method: "POST" }))
				.status,
		).toBe(401);
		const granted = new URLSearchParams({ c: VAULT, t: token });
		expect((await call(`/hub/signal?${granted}`, env)).status).toBe(405);
		expect(calls.signals).toEqual([]);
	});

	it("takes no HTTP signal from a read-only participant", async () => {
		const { env, calls } = makeEnv(await shareKv());
		const query = new URLSearchParams({ c: SHARE, t: VIEWER_TOKEN });

		const response = await call(`/hub/signal?${query}`, env, {
			method: "POST",
		});

		expect(response.status).toBe(403);
		expect(calls.signals).toEqual([]);
	});

	it("reports whether the relay secret matches", async () => {
		const status = (secret: string, env = makeEnv().env) =>
			call("/status", env, { headers: { "X-Obsync-Admin": secret } });

		expect((await status(SECRET)).status).toBe(200);
		expect((await status("wrong")).status).toBe(401);
		expect((await status("", makeEnv(new FakeKV(), null).env)).status).toBe(
			401,
		);
	});

	it("leaves unknown paths to the worker's own not-found", async () => {
		expect((await call("/nowhere", makeEnv().env)).status).toBe(404);
	});
});

describe("keepalive", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("answers the plugin's ping without waking the hub", async () => {
		const pairs: unknown[][] = [];
		vi.stubGlobal(
			"WebSocketRequestResponsePair",
			class {
				constructor(...args: unknown[]) {
					pairs.push(args);
				}
			},
		);
		const setWebSocketAutoResponse = vi.fn();
		const { Hub } = await import("../../src/hub/durable-object");

		new Hub(
			{
				setWebSocketAutoResponse,
				storage: { sql: memorySql() },
			} as unknown as DurableObjectState,
			{} as Env,
		);

		expect(setWebSocketAutoResponse).toHaveBeenCalledOnce();
		expect(pairs).toEqual([["ping", "pong"]]);
	});
});
