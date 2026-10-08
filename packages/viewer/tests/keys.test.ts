import "fake-indexeddb/auto";

import { deriveLinkKeys, newLinkKey, newLinkSalt } from "@mdsync/protocol";
import { createStore, get } from "idb-keyval";
import { afterEach, describe, expect, it, vi } from "vitest";

import { browserKeys } from "../src/keys";

afterEach(() => {
	vi.useRealTimers();
});

async function protectedKeys() {
	return deriveLinkKeys(newLinkKey(), {
		passphrase: "correct horse",
		salt: newLinkSalt(),
	});
}

describe("browser keys", () => {
	it("keeps a non-extractable key and the gate until dropped", async () => {
		const store = browserKeys();
		const keys = await protectedKeys();
		await store.put("a", keys, null);

		const kept = await store.get("a");
		expect(kept?.gate).toBe(keys.gate);
		expect(kept?.content.extractable).toBe(false);

		await store.drop("a");
		expect(await store.get("a")).toBeNull();
	});

	it("drops refused keys only while they are still the kept ones", async () => {
		const store = browserKeys();
		const old = await protectedKeys();
		const newer = await protectedKeys();
		await store.put("c", newer, null);
		await store.drop("c", old);
		expect((await store.get("c"))?.gate).toBe(newer.gate);
		await store.drop("c", newer);
		expect(await store.get("c")).toBeNull();
	});

	it("forgets keys once their link has expired", async () => {
		const store = browserKeys();
		const now = 1_900_000_000_000;
		vi.useFakeTimers({ now, toFake: ["Date"] });
		await store.put("b", await protectedKeys(), now / 1000 + 60);
		expect(await store.get("b")).not.toBeNull();

		vi.setSystemTime(now + 60_000);
		expect(await store.get("b")).toBeNull();
		await store.put("b", await protectedKeys(), now / 1000);
		expect(await store.get("b")).toBeNull();
	});

	it("erases expired keys of links never opened again", async () => {
		const now = 1_900_000_000_000;
		vi.useFakeTimers({ now, toFake: ["Date"] });
		await browserKeys().put("gone", await protectedKeys(), now / 1000 + 60);
		await browserKeys().put("kept", await protectedKeys(), null);

		vi.setSystemTime(now + 60_000);
		await browserKeys().get("other");

		const raw = createStore("mdsync-viewer", "keys");
		expect(await get("gone", raw)).toBeUndefined();
		expect(await get("kept", raw)).toBeDefined();
	});
});
