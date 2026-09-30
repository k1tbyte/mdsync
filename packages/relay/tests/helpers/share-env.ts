import { expect } from "vitest";
import { handleShareRequest } from "../../src/share/broker";
import { EShareRole, type ShareEnv } from "../../src/share/kv";
import { FakeKV } from "./fake-kv";

export const ADMIN = "admin-secret";
export const SHARE = "share1";
export const STORAGE = {
	endpoint: "https://s3.example.com",
	region: "us-east-1",
	bucket: "bucket",
	prefix: "vault",
	accessKeyId: "AKIA",
	secretAccessKey: "secret",
	forcePathStyle: true,
};

export type TestEnv = ShareEnv & {
	SHARE_TOKENS: FakeKV;
	dropped: string[];
	purged: [channel: string, droppedBefore: number][];
};

export function makeEnv(kv = new FakeKV()): TestEnv {
	const dropped: string[] = [];
	const purged: TestEnv["purged"] = [];
	// The hub records which grants the broker asked it to cut, and which channels to empty.
	const hub = {
		idFromName: (name: string) => ({ name }),
		get: () => ({
			dropGrant: async (grant: string) => {
				dropped.push(grant);
			},
			purgeChannel: async (channel: string) => {
				purged.push([channel, dropped.length]);
			},
		}),
	};
	return {
		SHARE_TOKENS: kv,
		RELAY_SECRET: ADMIN,
		HUB: hub,
		dropped,
		purged,
	} as unknown as TestEnv;
}

/** A share whose owner has already registered its storage, as the plugin does. */
export async function registeredEnv(kv = new FakeKV()): Promise<TestEnv> {
	const env = makeEnv(kv);
	expect((await register(env)).status).toBe(200);
	return env;
}

export function register(
	env: ShareEnv,
	storage: unknown = STORAGE,
	shareId = SHARE,
): Promise<Response> {
	return call(env, `/share/shares/${shareId}`, {
		method: "PUT",
		admin: true,
		body: JSON.stringify(storage),
	});
}

export async function call(
	env: ShareEnv,
	path: string,
	init: RequestInit & { admin?: boolean; token?: string } = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	if (init.admin) headers.set("X-Obsync-Admin", ADMIN);
	if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
	if (init.body) headers.set("Content-Type", "application/json");
	const url = new URL(`https://broker.example.com${path}`);
	const request = new Request(url, {
		method: init.method ?? "GET",
		headers,
		body: init.body,
	});
	const response = await handleShareRequest(request, env, url);
	if (!response) throw new Error(`not a broker route: ${path}`);
	return response;
}

export async function issue(
	env: ShareEnv,
	participantId: string,
	role: EShareRole = EShareRole.ReadWrite,
): Promise<string> {
	const response = await call(env, "/share/tokens", {
		method: "POST",
		admin: true,
		body: JSON.stringify({ shareId: SHARE, participantId, role }),
	});
	expect(response.status).toBe(200);
	return ((await response.json()) as { token: string }).token;
}

export function sign(
	env: ShareEnv,
	token: string,
	body: unknown,
): Promise<Response> {
	return call(env, "/share/sign", {
		method: "POST",
		token,
		body: JSON.stringify(body),
	});
}
