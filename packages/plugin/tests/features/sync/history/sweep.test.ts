import { FakeStorage } from "@tests/helpers/fake-storage";
import { manifestOf, pinSnapshot, seedChain } from "@tests/helpers/history";
import { putChunks, putRecipe } from "@tests/helpers/recipes";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { deriveKey, type EncryptionKey } from "@/core/crypto/cipher";
import { chunkKey, objectKey, recipeKey } from "@/features/sync/content/keys";
import { writeCandidates } from "@/features/sync/history/remote";
import { sweepObjects } from "@/features/sync/history/sweep";
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

describe("sweepObjects, chunked files", () => {
	const part = new Uint8Array([7]);

	/** HEAD's A2 and the orphan Z are chunked and share `shared`; `loose` is named by no recipe. */
	async function chunked(): Promise<FakeStorage> {
		const storage = await seeded();
		await putChunks(storage, key, {
			a0: part,
			z0: part,
			shared: part,
			loose: part,
		});
		await putRecipe(storage, key, "A2", [
			["a0", 1],
			["shared", 1],
		]);
		await putRecipe(storage, key, "Z", [
			["z0", 1],
			["shared", 1],
		]);
		return storage;
	}

	it("deep clean deletes orphan roots, then every settled chunk no surviving recipe names", async () => {
		const storage = await chunked();
		storage.age(SETTLED_AFTER_MS + MINUTE);
		const deleted: string[] = [];
		const remove = storage.delete.bind(storage);
		vi.spyOn(storage, "delete").mockImplementation((storageKey) => {
			deleted.push(storageKey);
			return remove(storageKey);
		});

		expect(await sweepObjects(storage, key, "")).toBe(4);

		expect(deleted.slice(0, 2).sort()).toEqual([
			objectKey("Z"),
			recipeKey("Z"),
		]);
		expect(deleted.slice(2).sort()).toEqual([
			chunkKey("loose"),
			chunkKey("z0"),
		]);
		for (const kept of [recipeKey("A2"), chunkKey("a0"), chunkKey("shared")]) {
			expect(storage.map.has(kept)).toBe(true);
		}
	});

	it("keeps the settled chunks a young recipe names, even one nothing reaches", async () => {
		const storage = await chunked();
		storage.age(SETTLED_AFTER_MS + MINUTE);
		await putRecipe(storage, key, "Y", [["loose", 1]]);

		await sweepObjects(storage, key, "");

		expect(storage.map.has(recipeKey("Y"))).toBe(true);
		expect(storage.map.has(chunkKey("loose"))).toBe(true);
		expect(storage.map.has(chunkKey("z0"))).toBe(false);
	});

	it("deletes nothing when a surviving recipe does not read", async () => {
		const storage = await chunked();
		await storage.put(recipeKey("A2"), new Uint8Array([3, 1, 2]));
		storage.age(SETTLED_AFTER_MS + MINUTE);
		const before = [...storage.map.keys()].sort();

		await expect(sweepObjects(storage, key, "")).rejects.toThrow(
			/could not be read/,
		);
		expect([...storage.map.keys()].sort()).toEqual(before);
	});

	it("keeps the chunks of a recipe that settles while the sweep reads", async () => {
		const storage = await chunked();
		await putRecipe(storage, key, "Y", [["shared", 1]]);
		await writeCandidates(storage, key, ["Z", "Y"]);
		storage.age(SETTLED_AFTER_MS + MINUTE);
		const start = Date.now();
		storage.modified.set(recipeKey("Y"), start - SETTLED_AFTER_MS + 1000);
		await putRecipe(storage, key, "A2", [["a0", 1]]);
		const get = storage.get.bind(storage);
		vi.spyOn(storage, "get").mockImplementation((storageKey) => {
			if (storageKey === recipeKey("Z")) {
				vi.spyOn(Date, "now").mockReturnValue(start + 5000);
			}
			return get(storageKey);
		});

		await sweepObjects(storage, key, "", { freedOnly: true });
		vi.mocked(Date.now).mockRestore();

		expect(storage.map.has(recipeKey("Z"))).toBe(false);
		expect(storage.map.has(recipeKey("Y"))).toBe(true);
		expect(storage.map.has(chunkKey("shared"))).toBe(true);
	});

	it("phase 2 takes only the chunks of the recipes it deletes", async () => {
		const storage = await chunked();
		await writeCandidates(storage, key, ["Z"]);
		storage.age(SETTLED_AFTER_MS + MINUTE);

		expect(await sweepObjects(storage, key, "", { freedOnly: true })).toBe(3);

		expect(storage.map.has(chunkKey("z0"))).toBe(false);
		expect(storage.map.has(chunkKey("shared"))).toBe(true);
		expect(storage.map.has(chunkKey("loose"))).toBe(true);
	});
});
