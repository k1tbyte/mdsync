import { FakeStorage } from "@tests/helpers/fake-storage";
import { putRecipe } from "@tests/helpers/recipes";
import { RevalidatingStorage } from "@tests/helpers/revalidating-storage";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { deriveKey, type EncryptionKey, encryptBytes } from "@/core/crypto";
import type { ListedObject } from "@/features/storage";
import {
	chunksNamed,
	forgetUnlistedRecipes,
} from "@/features/sync/content/closure";
import { chunkKey, recipeKey } from "@/features/sync/content/keys";

const A = "a".repeat(64);
const B = "b".repeat(64);

let key: EncryptionKey;
beforeAll(async () => {
	key = await deriveKey("pw", new Uint8Array(16));
});

const listing = (storage: FakeStorage): Promise<ListedObject[]> =>
	storage.listDetailed("recipes/");

const chunks = (...ids: string[]): Set<string> => new Set(ids.map(chunkKey));

/** The keys `get` was asked for. */
const reads = (get: { mock: { calls: unknown[][] } }): unknown[] =>
	get.mock.calls.map(([at]) => at);

describe("chunksNamed", () => {
	it("names the chunks of every listed recipe", async () => {
		const storage = new RevalidatingStorage();
		await putRecipe(storage, key, A, [
			["a0", 1],
			["a1", 1],
		]);
		await putRecipe(storage, key, B, [["b0", 1]]);

		const named = await chunksNamed(storage, key, await listing(storage), 4);

		expect(named.chunks).toEqual(chunks("a0", "a1", "b0"));
		expect(named.unreadable).toEqual([]);
	});

	it("reads nothing for a recipe whose etag it holds", async () => {
		const storage = new RevalidatingStorage();
		await putRecipe(storage, key, A, [["a0", 1]]);
		const listed = await listing(storage);
		await chunksNamed(storage, key, listed, 4);
		const get = vi.spyOn(storage, "get");

		const again = await chunksNamed(storage, key, listed, 4);

		expect(get).not.toHaveBeenCalled();
		expect(again.chunks).toEqual(chunks("a0"));
	});

	it("reads a recipe again once its etag moved", async () => {
		const storage = new RevalidatingStorage();
		await putRecipe(storage, key, A, [["a0", 1]]);
		await chunksNamed(storage, key, await listing(storage), 4);
		await putRecipe(storage, key, A, [["a1", 1]]);
		const get = vi.spyOn(storage, "get");

		const named = await chunksNamed(storage, key, await listing(storage), 4);

		expect(reads(get)).toEqual([recipeKey(A)]);
		expect(named.chunks).toEqual(chunks("a1"));
	});

	it("does not remember a read listed without an etag", async () => {
		const storage = new FakeStorage();
		await putRecipe(storage, key, A, [["a0", 1]]);
		const listed = await listing(storage);
		expect(listed[0]?.etag).toBeNull();
		await chunksNamed(storage, key, listed, 4);
		const get = vi.spyOn(storage, "get");

		const again = await chunksNamed(storage, key, listed, 4);

		expect(reads(get)).toEqual([recipeKey(A)]);
		expect(again.chunks).toEqual(chunks("a0"));
	});

	it("reports a recipe that does not read, and still names the others", async () => {
		const storage = new RevalidatingStorage();
		await putRecipe(storage, key, A, [["a0", 1]]);
		await storage.put(
			recipeKey(B),
			await encryptBytes(key, new TextEncoder().encode("no recipe")),
		);

		const named = await chunksNamed(storage, key, await listing(storage), 4);

		expect(named.unreadable).toEqual([recipeKey(B)]);
		expect(named.chunks).toEqual(chunks("a0"));
	});

	it("does not remember a recipe that failed to read", async () => {
		const storage = new FakeStorage();
		// Listed under one etag throughout: only a remembered failure could keep it unreadable.
		const listed: ListedObject[] = [
			{ key: recipeKey(A), etag: '"e1"', modified: null },
		];
		await storage.put(recipeKey(A), new Uint8Array([1, 2, 3]));
		expect((await chunksNamed(storage, key, listed, 4)).unreadable).toEqual([
			recipeKey(A),
		]);

		await putRecipe(storage, key, A, [["a0", 1]]);
		const named = await chunksNamed(storage, key, listed, 4);

		expect(named.unreadable).toEqual([]);
		expect(named.chunks).toEqual(chunks("a0"));
	});

	it("names nothing for a recipe gone since the listing, and keeps the rest", async () => {
		const storage = new RevalidatingStorage();
		await putRecipe(storage, key, A, [["a0", 1]]);
		await putRecipe(storage, key, B, [["b0", 1]]);
		const listed = await listing(storage);
		await storage.delete(recipeKey(A));

		const named = await chunksNamed(storage, key, listed, 4);

		expect(named.chunks).toEqual(chunks("b0"));
		expect(named.unreadable).toEqual([]);
	});
});

describe("forgetUnlistedRecipes", () => {
	it("drops what a listing no longer holds, so only that recipe is read again", async () => {
		const storage = new RevalidatingStorage();
		await putRecipe(storage, key, A, [["a0", 1]]);
		await putRecipe(storage, key, B, [["b0", 1]]);
		const listed = await listing(storage);
		await chunksNamed(storage, key, listed, 4);

		forgetUnlistedRecipes(
			storage,
			listed.filter(({ key: at }) => at === recipeKey(A)),
		);
		const get = vi.spyOn(storage, "get");
		const named = await chunksNamed(storage, key, listed, 4);

		expect(reads(get)).toEqual([recipeKey(B)]);
		expect(named.chunks).toEqual(chunks("a0", "b0"));
	});
});
