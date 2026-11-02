import { FakeStorage } from "@tests/helpers/fake-storage";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { REMOTE_MANIFEST_KEY } from "@/core/constants";
import { deriveKey, type EncryptionKey } from "@/core/crypto/cipher";
import {
	REMOTE_HISTORY_LOG_KEY,
	REMOTE_KEYFILE_KEY,
	REMOTE_PINS_PREFIX,
	REMOTE_SALT_KEY,
} from "@/features/sync/constants";
import { chunkKey, objectKey, recipeKey } from "@/features/sync/content/keys";
import { pushKey } from "@/features/sync/history/remote";
import { resetRemoteStorage } from "@/features/sync/remote/reset";

let key: EncryptionKey;
beforeAll(async () => {
	key = await deriveKey("pw", new Uint8Array(16));
});

function seed(): FakeStorage {
	const storage = new FakeStorage();
	const bytes = new Uint8Array([1]);
	storage.map.set(REMOTE_MANIFEST_KEY, bytes);
	storage.map.set(objectKey("aaa"), bytes);
	storage.map.set(objectKey("bbb"), bytes);
	storage.map.set(recipeKey("ccc"), bytes);
	storage.map.set(chunkKey("c0"), bytes);
	storage.map.set(`${REMOTE_PINS_PREFIX}snap1.json.enc`, bytes);
	storage.map.set(REMOTE_HISTORY_LOG_KEY, bytes);
	storage.map.set(pushKey("s1"), bytes);
	storage.map.set(REMOTE_SALT_KEY, bytes);
	storage.map.set(REMOTE_KEYFILE_KEY, bytes);
	return storage;
}

describe("resetRemoteStorage", () => {
	it("deletes the manifest, the objects and the history", async () => {
		const storage = seed();
		const result = await resetRemoteStorage(storage, 2);

		expect(storage.map.has(REMOTE_MANIFEST_KEY)).toBe(false);
		expect(storage.map.has(objectKey("aaa"))).toBe(false);
		expect(storage.map.has(objectKey("bbb"))).toBe(false);
		expect(storage.map.has(`${REMOTE_PINS_PREFIX}snap1.json.enc`)).toBe(false);
		expect(storage.map.has(REMOTE_HISTORY_LOG_KEY)).toBe(false);
		expect(storage.map.has(pushKey("s1"))).toBe(false);
		expect(result.deletedKeys).toContain(REMOTE_MANIFEST_KEY);
	});

	it("deletes chunked files, their chunks only after every root", async () => {
		const storage = seed();
		const deleted: string[] = [];
		const remove = storage.delete.bind(storage);
		vi.spyOn(storage, "delete").mockImplementation((storageKey) => {
			deleted.push(storageKey);
			return remove(storageKey);
		});

		await resetRemoteStorage(storage, 4);

		expect(storage.map.has(recipeKey("ccc"))).toBe(false);
		expect(deleted.at(-1)).toBe(chunkKey("c0"));
	});

	it("keeps the salt and the keyfile, so the passphrase still works", async () => {
		const storage = seed();
		await resetRemoteStorage(storage, 2);

		expect(storage.map.has(REMOTE_SALT_KEY)).toBe(true);
		expect(storage.map.has(REMOTE_KEYFILE_KEY)).toBe(true);
	});

	it("is safe to run twice", async () => {
		const storage = seed();
		await resetRemoteStorage(storage, 2);
		const second = await resetRemoteStorage(storage, 2);
		expect(second.deletedKeys).toEqual([
			REMOTE_MANIFEST_KEY,
			REMOTE_HISTORY_LOG_KEY,
		]);
	});

	it("leaves an unrelated key alone", async () => {
		const storage = seed();
		storage.map.set("not-ours.txt", new Uint8Array([9]));
		await resetRemoteStorage(storage, 2);
		expect(storage.map.has("not-ours.txt")).toBe(true);
		expect(key).toBeDefined();
	});
});
