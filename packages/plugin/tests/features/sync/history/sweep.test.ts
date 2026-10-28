import { FakeStorage } from "@tests/helpers/fake-storage";
import { manifestOf, pinSnapshot, seedChain } from "@tests/helpers/history";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { deriveKey, type EncryptionKey } from "@/core/crypto/cipher";
import { writeCandidates } from "@/features/sync/history/remote";
import { sweepObjects } from "@/features/sync/history/sweep";
import { objectKey } from "@/features/sync/remote/manifest";
import { SETTLED_AFTER_MS } from "@/features/sync/remote/uploads";

let key: EncryptionKey;
beforeAll(async () => {
	key = await deriveKey("pw", new Uint8Array(16));
});

const MINUTE = 60_000;
const old = manifestOf("s1", null, { "a.md": "A1" });
const head = manifestOf("s2", "s1", { "a.md": "A2" });

/** HEAD names A2 and no record names anything: only a pin can hold A1. */
async function seeded(): Promise<FakeStorage> {
	const storage = new FakeStorage();
	await seedChain(storage, key, [old, head], ["s1", "s2"]);
	for (const hash of ["A1", "A2", "Z"]) {
		await storage.put(objectKey(hash), new Uint8Array([1]));
	}
	await pinSnapshot(storage, key, old);
	return storage;
}

function objectListings(storage: FakeStorage): () => number {
	const listed = vi.spyOn(storage, "listDetailed");
	return () =>
		listed.mock.calls.filter(([prefix]) => prefix.startsWith("objects/"))
			.length;
}

describe("sweepObjects freedOnly", () => {
	it("deletes the due candidate file and never lists objects/ when every freed hash is still reachable", async () => {
		const storage = await seeded();
		await writeCandidates(storage, key, ["A1"]);
		const [due] = await storage.list("history/g/");
		storage.age(SETTLED_AFTER_MS + MINUTE);
		await writeCandidates(storage, key, ["Z"]);
		const [, young] = await storage.list("history/g/");
		const listings = objectListings(storage);
		const get = vi.spyOn(storage, "get");

		expect(await sweepObjects(storage, key, "", { freedOnly: true })).toBe(0);

		expect(listings()).toBe(0);
		expect(get).not.toHaveBeenCalledWith(young);
		expect(await storage.list("history/g/")).toEqual([young]);
		expect(storage.map.has(due as string)).toBe(false);
		for (const hash of ["A1", "A2", "Z"]) {
			expect(storage.map.has(objectKey(hash))).toBe(true);
		}
	});

	it("lists, rechecks and deletes a freed blob nothing reaches", async () => {
		const storage = await seeded();
		await writeCandidates(storage, key, ["A1", "Z"]);
		storage.age(SETTLED_AFTER_MS + MINUTE);
		const listings = objectListings(storage);

		expect(await sweepObjects(storage, key, "", { freedOnly: true })).toBe(1);

		expect(listings()).toBe(1);
		expect(storage.map.has(objectKey("Z"))).toBe(false);
		expect(storage.map.has(objectKey("A1"))).toBe(true);
		expect(await storage.list("history/g/")).toEqual([]);
	});

	it("fails closed on an unreadable young candidate file when a blob could go", async () => {
		const storage = await seeded();
		await writeCandidates(storage, key, ["Z"]);
		storage.age(SETTLED_AFTER_MS + MINUTE);
		await storage.put("history/g/young.enc", new Uint8Array([1]));
		const before = [...storage.map.keys()].sort();

		await expect(
			sweepObjects(storage, key, "", { freedOnly: true }),
		).rejects.toThrow(/could not be read/);
		expect([...storage.map.keys()].sort()).toEqual(before);
	});
});
