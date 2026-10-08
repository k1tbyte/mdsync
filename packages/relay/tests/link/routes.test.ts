import {
	LINK_HEADERS,
	LINK_MAX_SEALED_BYTES,
	LINK_MAX_TTL_S,
	LINK_MAX_VIEWS,
	type LinkPutMode,
	newLinkId,
} from "@mdsync/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleLinkRequest, type LinkRouteEnv } from "../../src/link/routes";
import { type LinkSettings, LinkStore } from "../../src/link/store";
import { fingerprint } from "../../src/secret";
import { memorySql } from "../helpers/memory-sql";

const ADMIN = "admin-secret";
const GATE = "G".repeat(43);
const SALT = "S".repeat(22);
const BLOB = Uint8Array.from([1, 2, 3, 4, 5]);
const NOW_MS = 1_760_000_000_000;
const NOW_S = NOW_MS / 1000;

/** The Durable Object namespace as the worker sees it: one real store per id, no network. */
function makeEnv(): LinkRouteEnv {
	const stores = new Map<string, LinkStore>();
	const storeOf = (id: string) => {
		let store = stores.get(id);
		if (!store) {
			store = new LinkStore(memorySql());
			stores.set(id, store);
		}
		return store;
	};
	const LINK = {
		idFromName: (name: string) => name,
		get: (id: string) => ({
			put: async (
				blob: ArrayBuffer,
				settings: LinkSettings,
				mode: LinkPutMode,
			) => storeOf(id).put(blob, settings, mode),
			open: async (gate: string | null, client: string) =>
				storeOf(id).open(gate, client),
			status: async () => storeOf(id).status(),
			meta: async () => storeOf(id).meta(),
			revoke: async () => storeOf(id).revoke(),
		}),
	};
	return { RELAY_SECRET: ADMIN, LINK } as unknown as LinkRouteEnv;
}

async function call(
	env: LinkRouteEnv,
	path: string,
	init: RequestInit & { admin?: boolean } = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	if (init.admin) headers.set("X-Mdsync-Admin", ADMIN);
	const url = new URL(`https://relay.example.com${path}`);
	const response = await handleLinkRequest(
		new Request(url, { ...init, headers }),
		env,
		url,
	);
	if (!response) throw new Error(`not a link route: ${path}`);
	return response;
}

function put(
	env: LinkRouteEnv,
	id: string,
	query = "",
	headers: Record<string, string> = {},
	body: BodyInit = BLOB,
) {
	return call(env, `/link/${id}${query}`, {
		method: "PUT",
		admin: true,
		headers: { [LINK_HEADERS.gate]: GATE, ...headers },
		body,
	});
}

const open = (
	env: LinkRouteEnv,
	id: string,
	gate: string | null = GATE,
	ip = "203.0.113.7",
) =>
	call(env, `/link/${id}/open`, {
		method: "POST",
		headers: { "CF-Connecting-IP": ip },
		body: gate === null ? undefined : JSON.stringify({ gate }),
	});

const protectedHeaders = {
	[LINK_HEADERS.gate]: GATE,
	[LINK_HEADERS.salt]: SALT,
};

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW_MS);
});
afterEach(() => vi.useRealTimers());

describe("routing", () => {
	it("ignores anything outside /link/", async () => {
		const url = new URL("https://relay.example.com/share/sign");
		expect(
			await handleLinkRequest(new Request(url), makeEnv(), url),
		).toBeNull();
	});

	it("answers an unknown route or a malformed id with 404", async () => {
		const env = makeEnv();
		expect((await call(env, "/link/nope")).status).toBe(404);
		expect((await call(env, `/link/${newLinkId()}/other`)).status).toBe(404);
		expect((await call(env, `/link/${newLinkId()}/open/extra`)).status).toBe(
			404,
		);
	});

	it("answers a wrong method with 405 and the allowed set", async () => {
		const env = makeEnv();
		const id = newLinkId();
		expect((await call(env, `/link/${id}`)).headers.get("Allow")).toBe(
			"DELETE, PUT",
		);
		expect((await call(env, `/link/${id}/open`)).headers.get("Allow")).toBe(
			"POST",
		);
		expect(
			(await call(env, `/link/${id}/meta`, { method: "POST" })).status,
		).toBe(405);
		expect(
			(await call(env, `/link/${id}/status`, { method: "POST" })).status,
		).toBe(405);
	});
});

describe("owner routes", () => {
	it("refuse everything without the relay secret", async () => {
		const env = makeEnv();
		const id = newLinkId();
		await put(env, id);
		const bare = [
			call(env, `/link/${id}`, { method: "PUT", body: BLOB }),
			call(env, `/link/${id}`, { method: "DELETE" }),
			call(env, `/link/${id}/status`),
		];
		for (const response of await Promise.all(bare)) {
			expect(response.status).toBe(401);
		}
		expect((await open(env, id)).status).toBe(200);
	});

	it("fail closed when the deployment has no secret", async () => {
		const env = { ...makeEnv(), RELAY_SECRET: "" } as LinkRouteEnv;
		expect((await put(env, newLinkId())).status).toBe(401);
	});

	it("counts the ttl from the end of the upload", async () => {
		const env = makeEnv();
		const id = newLinkId();
		const slow = new ReadableStream<Uint8Array>({
			pull(controller) {
				vi.setSystemTime(NOW_MS + 10_000);
				controller.enqueue(BLOB);
				controller.close();
			},
		});
		const url = new URL(`https://relay.example.com/link/${id}?ttl=5`);
		const response = await handleLinkRequest(
			new Request(url, {
				method: "PUT",
				headers: { "X-Mdsync-Admin": ADMIN, [LINK_HEADERS.gate]: GATE },
				body: slow,
				duplex: "half",
			} as RequestInit),
			env,
			url,
		);
		expect(await response?.json()).toMatchObject({ expires: NOW_S + 15 });
		expect((await open(env, id)).status).toBe(200);
	});

	it("store a link and report its status", async () => {
		const env = makeEnv();
		const id = newLinkId();
		const expires = Math.floor(Date.now() / 1000) + 3600;
		const stored = await put(env, id, "?maxViews=3&ttl=3600");
		expect(await stored.json()).toEqual({
			stored: true,
			size: BLOB.length,
			expires,
		});
		await open(env, id);
		const status = await call(env, `/link/${id}/status`, { admin: true });
		expect(await status.json()).toEqual({
			views: 1,
			maxViews: 3,
			expires,
			protected: false,
			size: BLOB.length,
		});
	});

	it("revoke a link, repeatably", async () => {
		const env = makeEnv();
		const id = newLinkId();
		await put(env, id);
		for (let i = 0; i < 2; i++) {
			const response = await call(env, `/link/${id}`, {
				method: "DELETE",
				admin: true,
			});
			expect(await response.json()).toEqual({ revoked: true });
		}
		expect((await open(env, id)).status).toBe(404);
		expect(
			(await call(env, `/link/${id}/status`, { admin: true })).status,
		).toBe(404);
	});

	it("never replace a link that stands, unless asked to update it", async () => {
		const env = makeEnv();
		const id = newLinkId();
		await put(env, id);
		const clash = await put(env, id, "", {}, Uint8Array.from([7]));
		expect(clash.status).toBe(409);
		expect(((await clash.json()) as { error: string }).error).toBe("exists");
		const opened = await open(env, id);
		expect(new Uint8Array(await opened.arrayBuffer())).toEqual(BLOB);
	});

	it("update a link in place and keep its views", async () => {
		const env = makeEnv();
		const id = newLinkId();
		await put(env, id, "?maxViews=5&ttl=3600");
		await open(env, id);
		const updated = await put(
			env,
			id,
			"?update=1&maxViews=1&ttl=60",
			{},
			Uint8Array.from([9, 9]),
		);
		expect(updated.status).toBe(200);
		expect(await updated.json()).toEqual({ stored: true, size: 2 });
		const status = await call(env, `/link/${id}/status`, { admin: true });
		expect(await status.json()).toMatchObject({
			views: 1,
			maxViews: 5,
			expires: NOW_S + 3600,
		});
		const response = await open(env, id);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(
			Uint8Array.from([9, 9]),
		);
		expect(response.headers.get(LINK_HEADERS.viewsLeft)).toBe("3");
	});
});

describe("updating", () => {
	it("refuses a wrong gate with 403 and keeps the old blob", async () => {
		const env = makeEnv();
		const id = newLinkId();
		await put(env, id);
		const response = await put(
			env,
			id,
			"?update=1",
			{ [LINK_HEADERS.gate]: "W".repeat(43) },
			Uint8Array.from([9]),
		);
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ error: "gate" });
		expect(new Uint8Array(await (await open(env, id)).arrayBuffer())).toEqual(
			BLOB,
		);
	});
	it("is 404 for a link that is spent, revoked or was never made", async () => {
		const env = makeEnv();
		const spent = newLinkId();
		const revoked = newLinkId();
		await put(env, spent, "?maxViews=1");
		await open(env, spent);
		await put(env, revoked);
		await call(env, `/link/${revoked}`, { method: "DELETE", admin: true });
		for (const id of [spent, revoked, newLinkId()]) {
			expect((await put(env, id, "?update=1")).status).toBe(404);
			expect((await open(env, id)).status).toBe(404);
		}
	});
});

describe("storing validates", () => {
	const reasons: [string, string, Record<string, string>][] = [
		["a zero view limit", "?maxViews=0", {}],
		["a view limit above the cap", `?maxViews=${LINK_MAX_VIEWS + 1}`, {}],
		["a fractional view limit", "?maxViews=1.5", {}],
		["a text view limit", "?maxViews=many", {}],
		["a zero ttl", "?ttl=0", {}],
		["a ttl past the cap", `?ttl=${LINK_MAX_TTL_S + 1}`, {}],
		["a missing gate", "", {}],
		["a salt without a gate", "", { [LINK_HEADERS.salt]: SALT }],
		[
			"a malformed gate",
			"",
			{ [LINK_HEADERS.gate]: "short", [LINK_HEADERS.salt]: SALT },
		],
		[
			"a malformed salt",
			"",
			{ [LINK_HEADERS.gate]: GATE, [LINK_HEADERS.salt]: "short" },
		],
	];

	it.each(reasons)("refuses %s", async (_name, query, headers) => {
		const env = makeEnv();
		const id = newLinkId();
		expect(
			(
				await call(env, `/link/${id}${query}`, {
					method: "PUT",
					admin: true,
					headers:
						_name === "a missing gate" || _name === "a salt without a gate"
							? headers
							: { [LINK_HEADERS.gate]: GATE, ...headers },
					body: BLOB,
				})
			).status,
		).toBe(400);
		expect((await open(env, id)).status).toBe(404);
	});

	it("refuses an empty body and one over the cap", async () => {
		const env = makeEnv();
		const id = newLinkId();
		expect((await put(env, id, "", {}, new Uint8Array(0))).status).toBe(400);
		const big = new Uint8Array(LINK_MAX_SEALED_BYTES + 1);
		expect((await put(env, id, "", {}, big)).status).toBe(413);
		expect(
			(await put(env, id, "", { "Content-Length": String(big.length) }, "x"))
				.status,
		).toBe(413);
		expect((await open(env, id)).status).toBe(404);
	});

	it("takes a body of exactly the cap", async () => {
		const env = makeEnv();
		const id = newLinkId();
		const body = new Uint8Array(LINK_MAX_SEALED_BYTES);
		expect((await put(env, id, "", {}, body)).status).toBe(200);
	});
});

describe("opening", () => {
	it("refuses an unprotected link without its gate and spends no view", async () => {
		const env = makeEnv();
		const id = newLinkId();
		await put(env, id, "?maxViews=1");
		expect((await open(env, id, null)).status).toBe(401);
		const status = await call(env, `/link/${id}/status`, { admin: true });
		expect(await status.json()).toMatchObject({ views: 0, protected: false });
		expect((await open(env, id)).status).toBe(200);
	});

	it.each([false, true])(
		"refuses an oversized open body with Content-Length %s",
		async (withLength) => {
			const env = makeEnv();
			const id = newLinkId();
			await put(env, id, "?maxViews=1");
			const body = JSON.stringify({ gate: GATE, padding: "x".repeat(1024) });
			const response = await call(env, `/link/${id}/open`, {
				method: "POST",
				body,
				headers: withLength ? { "Content-Length": String(body.length) } : {},
			});
			expect(response.status).toBe(401);
			const status = await call(env, `/link/${id}/status`, { admin: true });
			expect(await status.json()).toMatchObject({ views: 0 });
			expect((await open(env, id)).status).toBe(200);
		},
	);
	it("hands out the sealed bytes without caching and says how many views are left", async () => {
		const env = makeEnv();
		const id = newLinkId();
		const expires = NOW_S + 3600;
		await put(env, id, "?maxViews=2&ttl=3600");
		const first = await open(env, id);
		expect(first.status).toBe(200);
		expect(first.headers.get("Cache-Control")).toBe("no-store");
		expect(first.headers.get(LINK_HEADERS.viewsLeft)).toBe("1");
		expect(first.headers.get(LINK_HEADERS.expires)).toBe(String(expires));
		expect(new Uint8Array(await first.arrayBuffer())).toEqual(BLOB);
		const last = await open(env, id);
		expect(last.headers.get(LINK_HEADERS.viewsLeft)).toBe("0");
		expect(last.headers.get(LINK_HEADERS.expires)).toBe(String(expires));
	});

	it("names no count for an unlimited link", async () => {
		const env = makeEnv();
		const id = newLinkId();
		await put(env, id);
		const response = await open(env, id);
		expect(response.headers.has(LINK_HEADERS.viewsLeft)).toBe(false);
		expect(response.headers.has(LINK_HEADERS.expires)).toBe(false);
	});

	it("is gone for a spent, expired, revoked or never-made link alike", async () => {
		const env = makeEnv();
		const spent = newLinkId();
		const expiring = newLinkId();
		await put(env, spent, "?maxViews=1");
		await open(env, spent);
		await put(env, expiring, "?ttl=60");
		vi.setSystemTime(Date.now() + 61_000);
		const answers = await Promise.all(
			[spent, expiring, newLinkId()].map(async (id) => {
				const response = await open(env, id);
				return [response.status, await response.json()];
			}),
		);
		expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(
			1,
		);
		expect(answers[0]?.[0]).toBe(404);
	});

	it("serves exactly one of many simultaneous opens of a one-view link", async () => {
		const env = makeEnv();
		const id = newLinkId();
		await put(env, id, "?maxViews=1");
		const statuses = await Promise.all(
			Array.from({ length: 25 }, async () => (await open(env, id)).status),
		);
		expect(statuses.filter((status) => status === 200)).toHaveLength(1);
		expect(statuses.filter((status) => status === 404)).toHaveLength(24);
	});

	it("reports meta without spending a view", async () => {
		const env = makeEnv();
		const id = newLinkId();
		await put(env, id, "?maxViews=1", protectedHeaders);
		const meta = await call(env, `/link/${id}/meta`);
		expect(await meta.json()).toEqual({ protected: true, salt: SALT });
		expect((await open(env, id, GATE)).status).toBe(200);
		expect((await call(env, `/link/${id}/meta`)).status).toBe(404);
	});
});

describe("passphrase", () => {
	it("stores a hash of the gate, never the gate", async () => {
		const env = makeEnv();
		const id = newLinkId();
		await put(env, id, "", protectedHeaders);
		const stored = JSON.stringify(
			await (await call(env, `/link/${id}/status`, { admin: true })).json(),
		);
		expect(stored).not.toContain(GATE);
		expect(await fingerprint(GATE)).toHaveLength(64);
	});

	it("opens with the gate, refuses a wrong or missing one, and spends no view on those", async () => {
		const env = makeEnv();
		const id = newLinkId();
		await put(env, id, "?maxViews=1", protectedHeaders);
		const wrong = await open(env, id, "W".repeat(43));
		expect(wrong.status).toBe(401);
		expect(wrong.headers.get("Retry-After")).toBeNull();
		expect(((await wrong.json()) as { error: string }).error).toBe("gate");
		expect((await open(env, id, null)).status).toBe(401);
		expect((await open(env, id, "x".repeat(500))).status).toBe(401);
		expect((await open(env, id, GATE)).status).toBe(200);
	});

	it("answers 429 with Retry-After during the cooldown", async () => {
		const env = makeEnv();
		const id = newLinkId();
		await put(env, id, "", protectedHeaders);
		for (let i = 0; i < 4; i++) await open(env, id, "W".repeat(43));
		const fifth = await open(env, id, "W".repeat(43));
		expect(fifth.status).toBe(401);
		expect(fifth.headers.get("Retry-After")).toBe("60");
		const locked = await open(env, id, GATE);
		expect(locked.status).toBe(429);
		expect(locked.headers.get("Retry-After")).toBe("60");
		const other = await open(env, id, GATE, "198.51.100.9");
		expect(other.status).toBe(200);
		vi.setSystemTime(Date.now() + 60_000);
		expect((await open(env, id, GATE)).status).toBe(200);
	});
});
