import { FakeStorage } from "@tests/helpers/fake-storage";
import { manifestOf, seedChain } from "@tests/helpers/history";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	deriveKey,
	type EncryptionKey,
	encryptJson,
} from "@/core/crypto/cipher";
import { pushKey, readHistory } from "@/features/sync/history/remote";

let key: EncryptionKey;
beforeAll(async () => {
	key = await deriveKey("pw", new Uint8Array(16));
});

const chain = [
	manifestOf("s1", null, { "a.md": "A1" }),
	manifestOf("s2", "s1", { "a.md": "A2" }),
	manifestOf("s3", "s2", { "a.md": "A3" }),
];

async function seeded(): Promise<FakeStorage> {
	const storage = new FakeStorage();
	await seedChain(storage, key, chain);
	return storage;
}

const ids = (pushes: ReadonlyMap<string, { push: { id: string } }>): string[] =>
	[...pushes.values()].map(({ push }) => push.id).sort();

describe("readHistory", () => {
	it("decodes each record once across reads", async () => {
		const storage = await seeded();
		const get = vi.spyOn(storage, "get");

		await readHistory(storage, key, "");
		const { view } = await readHistory(storage, key, "");
		expect(ids(view.pushes)).toEqual(["s1", "s2", "s3"]);
		expect(get).toHaveBeenCalledTimes(3);
	});

	it("lists again when a record is gone before it is read", async () => {
		const storage = await seeded();
		const list = vi.spyOn(storage, "listDetailed");
		const get = storage.get.bind(storage);
		vi.spyOn(storage, "get").mockImplementation(async (objectKey) => {
			if (objectKey !== pushKey("s2")) return get(objectKey);
			await storage.delete(objectKey);
			return null;
		});

		const { view, unreadable } = await readHistory(storage, key, "");
		expect(ids(view.pushes)).toEqual(["s1", "s3"]);
		expect(unreadable).toEqual([]);
		expect(list).toHaveBeenCalledTimes(2);
	});

	it("names what it cannot decode, a newer format too, and reads the rest", async () => {
		const storage = await seeded();
		await storage.put(pushKey("s2"), new Uint8Array([1, 2, 3]));
		await storage.put(
			pushKey("s4"),
			await encryptJson(key, { v: 2, vaultId: "v", id: "s4" }),
		);

		const { view, unreadable } = await readHistory(storage, key, "");
		expect(ids(view.pushes)).toEqual(["s1", "s3"]);
		expect(unreadable.sort()).toEqual([pushKey("s2"), pushKey("s4")]);
	});

	it("dates an undated record by its parent's listing, a root one by the newest", async () => {
		const storage = await seeded();
		storage.modified.set(pushKey("s1"), 1_000);
		storage.modified.delete(pushKey("s2"));
		storage.modified.set(pushKey("s3"), 3_000);

		const { view } = await readHistory(storage, key, "");
		expect(view.pushes.get(pushKey("s2"))?.at).toBe(1_000);

		storage.modified.delete(pushKey("s1"));
		const again = await readHistory(storage, key, "");
		expect(again.view.pushes.get(pushKey("s1"))?.at).toBe(3_000);
		expect(again.now).toBe(3_000);
	});
});
