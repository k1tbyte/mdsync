import {
	deriveLinkKeys,
	type LinkKeys,
	type LinkMeta,
	type LinkPayload,
	newLinkId,
	newLinkKey,
	newLinkSalt,
	sealLinkPayload,
	toBase64Url,
} from "@mdsync/protocol";
import { describe, expect, it } from "vitest";

import type { LinkApi, OpenOutcome } from "../src/api";
import { type CachedLink, type LinkCache, sessionCache } from "../src/cache";
import type { RememberedKeys } from "../src/keys";
import { LinkSession, type ViewState } from "../src/session";

const payload: LinkPayload = {
	title: "Trip",
	html: "<p>Lisbon</p>",
	createdAt: 1,
};

async function link(passphrase?: string) {
	const id = newLinkId();
	const key = newLinkKey();
	const salt = newLinkSalt();
	const keys = await deriveLinkKeys(
		key,
		passphrase ? { passphrase, salt } : undefined,
	);
	const sealed = await sealLinkPayload(id, payload, keys.content);
	const meta: LinkMeta = passphrase
		? { protected: true, salt: toBase64Url(salt) }
		: { protected: false, salt: null };
	return { id, key, sealed, meta, gate: keys.gate };
}

function fakeApi(
	meta: LinkMeta | null,
	open: (gate: string | null) => OpenOutcome,
): LinkApi & { opens: (string | null)[]; metas: number } {
	const calls = { opens: [] as (string | null)[], metas: 0 };
	return {
		get opens() {
			return calls.opens;
		},
		get metas() {
			return calls.metas;
		},
		async meta() {
			calls.metas++;
			return meta;
		},
		async open(_id, gate) {
			calls.opens.push(gate);
			return open(gate);
		},
	};
}

function memoryCache(): LinkCache & { stored: Map<string, CachedLink> } {
	const stored = new Map<string, CachedLink>();
	return {
		stored,
		get: (id) => stored.get(id) ?? null,
		put: (id, entry) => void stored.set(id, entry),
	};
}

function memoryKeys(): RememberedKeys & {
	stored: Map<string, { keys: LinkKeys; expires: number | null }>;
} {
	const stored = new Map<string, { keys: LinkKeys; expires: number | null }>();
	return {
		stored,
		get: async (id) => stored.get(id)?.keys ?? null,
		put: async (id, keys, expires) => void stored.set(id, { keys, expires }),
		drop: async (id, stale) => {
			if (stale && stored.get(id)?.keys.gate !== stale.gate) return;
			stored.delete(id);
		},
	};
}

function harness(deps: {
	id: string;
	key: Uint8Array;
	api: LinkApi;
	cache?: LinkCache;
	keys?: ReturnType<typeof memoryKeys>;
}) {
	const states: ViewState[] = [];
	const cache = deps.cache ?? memoryCache();
	const keys = deps.keys ?? memoryKeys();
	const session = new LinkSession({
		...deps,
		cache,
		keys,
		show: (state) => states.push(state),
	});
	return { session, states, cache, keys, last: () => states.at(-1) };
}

describe("an open link", () => {
	it("shows the note and keeps the sealed bytes for a reload", async () => {
		const { id, key, sealed, meta } = await link();
		const expires = 1_760_003_600;
		const api = fakeApi(meta, () => ({
			kind: "opened",
			sealed,
			viewsLeft: 4,
			expires,
		}));
		const { session, last, cache } = harness({ id, key, api });
		await session.start();
		expect(last()).toEqual({ kind: "content", payload, viewsLeft: 4, expires });
		expect(api.opens).toEqual([null]);
		expect(cache.get(id)).toEqual({ ...meta, sealed, viewsLeft: 4, expires });
	});

	it("shows a reload from the cache without asking the relay", async () => {
		const { id, key, sealed, meta } = await link();
		const expires = 1_760_003_600;
		const api = fakeApi(meta, () => ({
			kind: "opened",
			sealed,
			viewsLeft: 0,
			expires,
		}));
		const first = harness({ id, key, api });
		await first.session.start();
		const second = harness({ id, key, api, cache: first.cache });
		await second.session.start();
		expect(second.last()).toEqual({
			kind: "content",
			payload,
			viewsLeft: 0,
			expires,
		});
		expect(api.opens).toHaveLength(1);
		expect(api.metas).toBe(1);
	});
});

describe("session storage cache", () => {
	it("keeps the expiry with the sealed bytes", () => {
		const id = newLinkId();
		const entry: CachedLink = {
			sealed: Uint8Array.from([1, 2, 3]),
			protected: false,
			salt: null,
			viewsLeft: 2,
			expires: 1_760_003_600,
		};
		sessionCache().put(id, entry);
		expect(sessionCache().get(id)).toEqual(entry);
	});

	it("reloads an older cached entry without an expiry or another view", async () => {
		const { id, key, sealed, meta } = await link();
		sessionStorage.setItem(
			`mdsync-link:${id}`,
			JSON.stringify({ ...meta, sealed: toBase64Url(sealed), viewsLeft: 0 }),
		);
		const cache = sessionCache();
		expect(cache.get(id)?.expires).toBeNull();
		const api = fakeApi(meta, () => ({ kind: "gone" }));
		const { session, last } = harness({ id, key, api, cache });
		await session.start();
		expect(last()).toEqual({
			kind: "content",
			payload,
			viewsLeft: 0,
			expires: null,
		});
		expect(api.opens).toHaveLength(0);
		expect(api.metas).toBe(0);
	});
});

describe("a link that is gone", () => {
	it("says so when meta finds nothing", async () => {
		const { id, key } = await link();
		const api = fakeApi(null, () => ({ kind: "gone" }));
		const { session, last } = harness({ id, key, api });
		await session.start();
		expect(last()).toEqual({ kind: "gone" });
		expect(api.opens).toHaveLength(0);
	});

	it("says so when the last view went to someone else meanwhile", async () => {
		const { id, key, meta } = await link();
		const api = fakeApi(meta, () => ({ kind: "gone" }));
		const { session, last } = harness({ id, key, api });
		await session.start();
		expect(last()).toEqual({ kind: "gone" });
	});
});

describe("a protected link", () => {
	it("asks for the passphrase before it spends a view", async () => {
		const { id, key, meta } = await link("correct horse");
		const api = fakeApi(meta, () => ({ kind: "gone" }));
		const { session, last } = harness({ id, key, api });
		await session.start();
		expect(last()).toEqual({ kind: "passphrase" });
		expect(api.opens).toHaveLength(0);
	});

	it("opens with the right passphrase, sending the gate and never the passphrase", async () => {
		const { id, key, sealed, meta, gate } = await link("correct horse");
		const api = fakeApi(meta, () => ({
			kind: "opened",
			sealed,
			viewsLeft: null,
			expires: null,
		}));
		const { session, last } = harness({ id, key, api });
		await session.start();
		await session.submit("correct horse", false);
		expect(last()).toEqual({
			kind: "content",
			payload,
			viewsLeft: null,
			expires: null,
		});
		expect(api.opens).toEqual([gate]);
	});

	it("says a passphrase is wrong, and how long to wait when the relay cools down", async () => {
		const { id, key, meta } = await link("correct horse");
		const outcomes: OpenOutcome[] = [
			{ kind: "gate", retryAfter: null },
			{ kind: "gate", retryAfter: 60 },
			{ kind: "cooldown", retryAfter: 600 },
		];
		const api = fakeApi(meta, () => outcomes.shift() as OpenOutcome);
		const { session, last } = harness({ id, key, api });
		await session.start();
		await session.submit("nope", false);
		expect(last()).toEqual({
			kind: "passphrase",
			problem: "Wrong passphrase.",
		});
		await session.submit("nope", false);
		expect(last()).toEqual({
			kind: "passphrase",
			problem: "Too many wrong attempts. Try again in 60 seconds.",
		});
		await session.submit("nope", false);
		expect(last()).toEqual({
			kind: "passphrase",
			problem: "Too many wrong attempts. Try again in 10 minutes.",
		});
	});

	it("asks again after a reload, and checks the passphrase locally", async () => {
		const { id, key, sealed, meta } = await link("correct horse");
		const api = fakeApi(meta, () => ({
			kind: "opened",
			sealed,
			viewsLeft: 2,
			expires: null,
		}));
		const first = harness({ id, key, api });
		await first.session.start();
		await first.session.submit("correct horse", false);
		const second = harness({ id, key, api, cache: first.cache });
		await second.session.start();
		expect(second.last()).toEqual({ kind: "passphrase" });
		await second.session.submit("wrong", false);
		expect(second.last()).toEqual({
			kind: "passphrase",
			problem: "Wrong passphrase.",
		});
		await second.session.submit("correct horse", false);
		expect(second.last()).toEqual({
			kind: "content",
			payload,
			viewsLeft: 2,
			expires: null,
		});
		expect(api.opens).toHaveLength(1);
	});

	it("remembers the keys, so another tab opens it without asking", async () => {
		const { id, key, sealed, meta, gate } = await link("correct horse");
		const api = fakeApi(meta, () => ({
			kind: "opened",
			sealed,
			viewsLeft: 3,
			expires: 1_900_000_000,
		}));
		const first = harness({ id, key, api });
		await first.session.start();
		await first.session.submit("correct horse", true);
		expect(first.keys.stored.get(id)?.expires).toBe(1_900_000_000);

		const second = harness({ id, key, api, keys: first.keys });
		await second.session.start();
		expect(second.states).not.toContainEqual({ kind: "passphrase" });
		expect(second.last()).toMatchObject({ kind: "content", payload });
		expect(api.opens).toEqual([gate, gate]);
	});

	it("keeps nothing when told not to remember", async () => {
		const { id, key, sealed, meta } = await link("correct horse");
		const api = fakeApi(meta, () => ({
			kind: "opened",
			sealed,
			viewsLeft: null,
			expires: null,
		}));
		const { session, keys } = harness({ id, key, api });
		await session.start();
		await session.submit("correct horse", false);
		expect(keys.stored.size).toBe(0);
	});

	it("forgets kept keys the relay refuses, as after a new passphrase", async () => {
		const { id, key, meta } = await link("correct horse");
		const api = fakeApi(meta, () => ({ kind: "gate", retryAfter: null }));
		const keys = memoryKeys();
		await keys.put(id, await deriveLinkKeys(key), null);
		const { session, last } = harness({ id, key, api, keys });
		await session.start();
		expect(last()).toEqual({
			kind: "passphrase",
			problem: "The passphrase has changed. Type the new one.",
		});
		expect(keys.stored.size).toBe(0);
	});

	it("keeps kept keys a tab's older copy cannot open, and asks", async () => {
		const { id, key, sealed, meta } = await link("correct horse");
		const api = fakeApi(meta, () => ({
			kind: "opened",
			sealed,
			viewsLeft: null,
			expires: null,
		}));
		const first = harness({ id, key, api });
		await first.session.start();
		await first.session.submit("correct horse", false);
		const newer = await deriveLinkKeys(key, {
			passphrase: "new horse",
			salt: newLinkSalt(),
		});
		await first.keys.put(id, newer, null);

		const reload = harness({
			id,
			key,
			api,
			cache: first.cache,
			keys: first.keys,
		});
		await reload.session.start();
		expect(reload.last()).toEqual({ kind: "passphrase" });
		expect(first.keys.stored.get(id)?.keys).toBe(newer);
	});

	it("forgets kept keys once the link is gone", async () => {
		const { id, key } = await link("correct horse");
		const keys = memoryKeys();
		await keys.put(id, await deriveLinkKeys(key), null);
		const { session, last } = harness({
			id,
			key,
			api: fakeApi(null, () => ({ kind: "gone" })),
			keys,
		});
		await session.start();
		expect(last()).toEqual({ kind: "gone" });
		expect(keys.stored.size).toBe(0);
	});

	it("ignores an empty passphrase", async () => {
		const { id, key, meta } = await link("correct horse");
		const api = fakeApi(meta, () => ({ kind: "gone" }));
		const { session, states } = harness({ id, key, api });
		await session.start();
		const before = states.length;
		await session.submit("", false);
		expect(states).toHaveLength(before);
	});
});

describe("trouble", () => {
	it("reports a link whose key was cut short as damaged, not as wrong passphrase", async () => {
		const { id, sealed, meta } = await link();
		const api = fakeApi(meta, () => ({
			kind: "opened",
			sealed,
			viewsLeft: null,
			expires: null,
		}));
		const { session, last } = harness({ id, key: newLinkKey(), api });
		await session.start();
		expect(last()).toMatchObject({ kind: "error" });
	});

	it("reports an unreachable relay", async () => {
		const { id, key } = await link();
		const api: LinkApi = {
			meta: async () => {
				throw new TypeError("Failed to fetch");
			},
			open: async () => ({ kind: "gone" }),
		};
		const { session, last } = harness({ id, key, api });
		await session.start();
		expect(last()).toEqual({ kind: "error", message: "Failed to fetch" });
	});
});
