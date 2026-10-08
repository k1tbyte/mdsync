import { LINK_MAX_SEALED_BYTES } from "@mdsync/protocol";
import { describe, expect, it } from "vitest";

import { type LinkSettings, LinkStore } from "../../src/link/store";
import { memorySql } from "../helpers/memory-sql";

const OPEN: LinkSettings = {
	maxViews: null,
	expires: null,
	gate: null,
	salt: null,
};
const PROTECTED: LinkSettings = { ...OPEN, gate: "ab".repeat(32), salt: "s" };
const T0 = 1_760_000_000_000;
const ME = "client-me";
const RIGHT = PROTECTED.gate as string;
const WRONG = "cd".repeat(32);

function setup(settings: LinkSettings = OPEN, bytes = 100) {
	const sql = memorySql();
	const clock = { now: T0 };
	const ended = { count: 0 };
	const store = new LinkStore(
		sql,
		() => clock.now,
		() => ended.count++,
	);
	expect(store.put(blob(bytes, 1), settings, "create")).toBe("stored");
	return { sql, clock, ended, store };
}

function blob(length: number, seed: number): ArrayBuffer {
	const bytes = new Uint8Array(length);
	for (let i = 0; i < length; i++) bytes[i] = (i * 31 + seed) % 251;
	return bytes.buffer;
}

function served(result: ReturnType<LinkStore["open"]>): Uint8Array {
	if (!result.ok) throw new Error(`refused: ${result.reason}`);
	return new Uint8Array(result.blob);
}

const open = (store: LinkStore, gate: string | null = null, client = ME) =>
	store.open(gate, client);

describe("storing and serving", () => {
	it("serves back exactly what was stored", () => {
		const { store } = setup();
		expect(served(open(store))).toEqual(new Uint8Array(blob(100, 1)));
	});

	it("keeps a blob of several chunks intact", () => {
		const size = 2.5 * 1024 * 1024;
		const { store } = setup(OPEN, size);
		// A byte-for-byte toEqual on megabytes takes seconds.
		expect(
			Buffer.from(served(open(store))).equals(Buffer.from(blob(size, 1))),
		).toBe(true);
	});

	it("takes a blob of the largest size and refuses larger or empty ones", () => {
		const { store } = setup();
		expect(() =>
			store.put(blob(LINK_MAX_SEALED_BYTES, 2), OPEN, "update"),
		).not.toThrow();
		expect(() =>
			store.put(blob(LINK_MAX_SEALED_BYTES + 1, 2), OPEN, "update"),
		).toThrow();
		expect(() => store.put(new ArrayBuffer(0), OPEN, "update")).toThrow();
	});

	it("keeps serving an unlimited link", () => {
		const { store } = setup();
		for (let i = 0; i < 20; i++) {
			expect(open(store)).toMatchObject({ ok: true, expires: null });
		}
		expect(store.status()?.views).toBe(20);
	});
});

describe("view limit", () => {
	it("serves the last view and erases the link with it", () => {
		const expires = T0 / 1000 + 60;
		const { store, ended } = setup({ ...OPEN, maxViews: 2, expires });
		expect(open(store)).toMatchObject({ ok: true, viewsLeft: 1, expires });
		expect(open(store)).toMatchObject({ ok: true, viewsLeft: 0, expires });
		expect(ended.count).toBe(1);
		expect(open(store)).toEqual({ ok: false, reason: "gone" });
		expect(store.status()).toBeNull();
		expect(store.meta()).toBeNull();
	});

	it("serves a one-view link once", () => {
		const { store } = setup({ ...OPEN, maxViews: 1 });
		const results = Array.from({ length: 5 }, () => open(store));
		expect(results.filter((result) => result.ok)).toHaveLength(1);
	});

	it("counts nothing for status and meta", () => {
		const { store } = setup({ ...OPEN, maxViews: 3 });
		store.status();
		store.meta();
		expect(store.status()?.views).toBe(0);
	});
});

describe("expiry", () => {
	it("is gone once the time passes, and gives its storage back", () => {
		const expires = T0 / 1000 + 60;
		const { store, clock, ended } = setup({ ...OPEN, expires });
		clock.now += 59_000;
		expect(open(store)).toMatchObject({ ok: true, expires });
		clock.now += 1_000;
		expect(open(store)).toEqual({ ok: false, reason: "gone" });
		expect(ended.count).toBe(1);
	});
});

describe("passphrase gate", () => {
	it("serves only the right gate", () => {
		const { store } = setup(PROTECTED);
		expect(open(store, WRONG)).toMatchObject({ ok: false, reason: "gate" });
		expect(open(store)).toMatchObject({ ok: false, reason: "gate" });
		expect(open(store, RIGHT).ok).toBe(true);
	});

	it("spends no view on a wrong gate", () => {
		const { store } = setup({ ...PROTECTED, maxViews: 1 });
		for (let i = 0; i < 3; i++) open(store, WRONG);
		expect(store.status()?.views).toBe(0);
		expect(open(store, RIGHT).ok).toBe(true);
	});

	it("tells the viewer a passphrase is asked for, with its salt", () => {
		const { store } = setup(PROTECTED);
		expect(store.meta()).toEqual({ protected: true, salt: "s" });
		expect(setup().store.meta()).toEqual({ protected: false, salt: null });
	});

	it("cools a client down after five wrong guesses, even for the right gate", () => {
		const { store, clock } = setup(PROTECTED);
		for (let i = 0; i < 4; i++) {
			expect(open(store, WRONG)).toEqual({
				ok: false,
				reason: "gate",
				retryAfter: null,
			});
		}
		expect(open(store, WRONG)).toEqual({
			ok: false,
			reason: "gate",
			retryAfter: 60,
		});
		clock.now += 10_000;
		expect(open(store, RIGHT)).toEqual({
			ok: false,
			reason: "cooldown",
			retryAfter: 50,
		});
		clock.now += 50_000;
		expect(open(store, RIGHT).ok).toBe(true);
	});

	it("leaves every other client's access alone", () => {
		const { store } = setup(PROTECTED);
		for (let i = 0; i < 12; i++) open(store, WRONG, "attacker");
		expect(open(store, RIGHT, "attacker")).toMatchObject({
			reason: "cooldown",
		});
		expect(open(store, RIGHT, "reader").ok).toBe(true);
	});

	it("keeps a cooling client's lock when many others fail after it", () => {
		const { store, clock } = setup(PROTECTED);
		for (let i = 0; i < 5; i++) open(store, WRONG, "locked");
		for (let i = 0; i < 300; i++) {
			clock.now += 1;
			open(store, WRONG, `other-${i}`);
		}
		expect(open(store, RIGHT, "locked")).toMatchObject({ reason: "cooldown" });
	});

	it("doubles the cooldown on each further miss up to an hour", () => {
		const { store, clock } = setup(PROTECTED);
		const waits: (number | null)[] = [];
		for (let i = 0; i < 14; i++) {
			const result = open(store, WRONG);
			waits.push(
				result.ok || result.reason === "gone" ? -1 : result.retryAfter,
			);
			clock.now += 3_601_000;
		}
		expect(waits.slice(4, 9)).toEqual([60, 120, 240, 480, 960]);
		expect(waits.at(-1)).toBe(3600);
	});

	it("forgives a client's earlier misses after a good open", () => {
		const { store } = setup(PROTECTED);
		for (let i = 0; i < 4; i++) open(store, WRONG);
		expect(open(store, RIGHT).ok).toBe(true);
		for (let i = 0; i < 4; i++) {
			expect(open(store, WRONG)).toMatchObject({ retryAfter: null });
		}
	});

	it("remembers a bounded number of clients, the least recent going first", () => {
		const { store, sql } = setup(PROTECTED);
		for (let i = 0; i < 300; i++) open(store, WRONG, `client-${i}`);
		const [{ count }] = sql
			.exec("SELECT count(*) AS count FROM throttle")
			.toArray() as [{ count: number }];
		expect(count).toBe(128);
	});
});

describe("update", () => {
	it("replaces the blob and keeps the counter", () => {
		const { store } = setup({ ...OPEN, maxViews: 5 });
		open(store);
		open(store);
		expect(store.put(blob(50, 9), { ...OPEN, maxViews: 5 }, "update")).toBe(
			"stored",
		);
		expect(store.status()?.views).toBe(2);
		expect(served(open(store))).toEqual(new Uint8Array(blob(50, 9)));
	});

	it("leaves a link already past a lowered limit spent", () => {
		const { store } = setup({ ...OPEN, maxViews: 5 });
		open(store);
		open(store);
		store.put(blob(10, 3), { ...OPEN, maxViews: 2 }, "update");
		expect(open(store)).toEqual({ ok: false, reason: "gone" });
	});

	it("never brings back a link that is spent, expired or revoked", () => {
		const { store, clock } = setup({
			...OPEN,
			maxViews: 1,
			expires: T0 / 1000 + 10,
		});
		open(store);
		expect(store.put(blob(10, 3), OPEN, "update")).toBe("gone");
		expect(store.status()).toBeNull();

		const expiring = setup({ ...OPEN, expires: T0 / 1000 + 10 });
		expiring.clock.now += 20_000;
		expect(expiring.store.put(blob(10, 3), OPEN, "update")).toBe("gone");

		const revoked = setup();
		revoked.store.revoke();
		expect(revoked.store.put(blob(10, 3), OPEN, "update")).toBe("gone");
		expect(clock.now).toBe(T0);
	});

	it("clears every client's cooldown", () => {
		const { store } = setup(PROTECTED);
		for (let i = 0; i < 5; i++) open(store, WRONG);
		store.put(blob(10, 3), PROTECTED, "update");
		expect(open(store, RIGHT).ok).toBe(true);
	});

	it("can add or drop the passphrase", () => {
		const { store } = setup();
		store.put(blob(10, 3), PROTECTED, "update");
		expect(store.meta()?.protected).toBe(true);
		store.put(blob(10, 3), OPEN, "update");
		expect(store.meta()?.protected).toBe(false);
	});
});

describe("creating", () => {
	it("never replaces a link that stands", () => {
		const { store } = setup({ ...OPEN, maxViews: 5 });
		open(store);
		expect(store.put(blob(10, 4), OPEN, "create")).toBe("exists");
		expect(served(open(store))).toEqual(new Uint8Array(blob(100, 1)));
	});

	it("starts at no views once the link before it ended", () => {
		const { store, clock } = setup({ ...OPEN, expires: T0 / 1000 + 10 });
		open(store);
		clock.now += 20_000;
		expect(store.put(blob(10, 3), { ...OPEN, maxViews: 3 }, "create")).toBe(
			"stored",
		);
		expect(store.status()).toMatchObject({ views: 0, maxViews: 3 });
	});

	it("can reuse the id of a link that was spent", () => {
		const { store } = setup({ ...OPEN, maxViews: 1 });
		open(store);
		expect(store.put(blob(10, 4), { ...OPEN, maxViews: 2 }, "create")).toBe(
			"stored",
		);
		expect(store.status()?.views).toBe(0);
	});
});

describe("revoke and unknown links", () => {
	it("erases at once and can be repeated", () => {
		const { store, ended } = setup();
		store.revoke();
		store.revoke();
		expect(ended.count).toBe(1);
		expect(open(store)).toEqual({ ok: false, reason: "gone" });
	});

	it("makes no tables when asked about a link nobody created", () => {
		const sql = memorySql();
		const store = new LinkStore(sql);
		expect(open(store)).toEqual({ ok: false, reason: "gone" });
		expect(store.status()).toBeNull();
		expect(store.meta()).toBeNull();
		expect(store.put(blob(10, 1), OPEN, "update")).toBe("gone");
		store.revoke();
		expect(sql.exec("SELECT name FROM sqlite_master").toArray()).toEqual([]);
	});
});
