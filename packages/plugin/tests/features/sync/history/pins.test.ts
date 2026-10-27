import { FakeStorage } from "@tests/helpers/fake-storage";
import { manifestOf, pinSnapshot, seedChain } from "@tests/helpers/history";
import { RevalidatingStorage } from "@tests/helpers/revalidating-storage";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	decryptJson,
	deriveKey,
	type EncryptionKey,
	encryptJson,
} from "@/core/crypto/cipher";
import {
	pinKey,
	readPinById,
	readPins,
	writePin,
} from "@/features/sync/history/pins";
import { setSnapshotPinned } from "@/features/sync/history/query";
import { pushKey } from "@/features/sync/history/remote";
import type { Manifest } from "@/features/sync/types";

let key: EncryptionKey;
beforeAll(async () => {
	key = await deriveKey("pw", new Uint8Array(16));
});

const chain = [
	manifestOf("s1", null, { a: "A1" }),
	manifestOf("s2", "s1", { a: "A2", b: "B1" }),
	manifestOf("s3", "s2", { a: "A3" }),
];

async function seeded(): Promise<FakeStorage> {
	const storage = new FakeStorage();
	await seedChain(storage, key, chain);
	return storage;
}

describe("setSnapshotPinned", () => {
	it("stores the replayed manifest with its label", async () => {
		const storage = await seeded();
		await setSnapshotPinned({ storage, key, root: "" }, "s2", true, "Draft");

		const pin = await readPinById(storage, key, "", "s2");
		expect(pin?.manifest.files).toEqual(chain[1]?.files);
		expect(pin?.label).toBe("Draft");
	});

	it("deletes the pin on unpin", async () => {
		const storage = await seeded();
		const source = { storage, key, root: "" };
		await setSnapshotPinned(source, "s1", true);
		await setSnapshotPinned(source, "s1", false);
		expect(await storage.exists(pinKey("s1"))).toBe(false);
	});

	it("relabels a pin history no longer reaches, keeping its manifest", async () => {
		const storage = await seeded();
		const source = { storage, key, root: "" };
		await setSnapshotPinned(source, "s1", true, "Old");
		await storage.delete(pushKey("s2"));

		await setSnapshotPinned(source, "s1", true, "New");
		expect(await readPinById(storage, key, "", "s1")).toMatchObject({
			label: "New",
			manifest: { files: chain[0]?.files },
		});
		await setSnapshotPinned(source, "s1", true);
		expect((await readPinById(storage, key, "", "s1"))?.label).toBe("New");
		await setSnapshotPinned(source, "s1", true, "");
		expect((await readPinById(storage, key, "", "s1"))?.label).toBeUndefined();
	});

	it("rewrites a pin that cannot be read", async () => {
		const storage = await seeded();
		await storage.put(pinKey("s1"), new Uint8Array([1, 2, 3]));

		await setSnapshotPinned({ storage, key, root: "" }, "s1", true);
		expect((await readPinById(storage, key, "", "s1"))?.manifest.files).toEqual(
			chain[0]?.files,
		);
	});

	it("refuses a snapshot history can no longer rebuild", async () => {
		const storage = await seeded();
		await storage.delete(pushKey("s2"));

		await expect(
			setSnapshotPinned({ storage, key, root: "" }, "s1", true),
		).rejects.toThrow(/can no longer be rebuilt/);
		expect(await storage.exists(pinKey("s1"))).toBe(false);
	});
});

describe("readPins", () => {
	it("lists pins newest snapshot first and names the unreadable ones", async () => {
		const storage = new FakeStorage();
		await pinSnapshot(storage, key, manifestOf("old", null, {}, 1));
		await pinSnapshot(storage, key, manifestOf("new", null, {}, 2), "Kept");
		await storage.put(pinKey("bad"), new Uint8Array([1]));
		// The legacy shape: a bare manifest.
		await storage.put(
			pinKey("legacy"),
			await encryptJson(key, manifestOf("legacy", null, {})),
		);

		const read = await readPins(storage, key, "", () => null);
		expect(read.pins.map(({ info }) => [info.id, info.label])).toEqual([
			["new", "Kept"],
			["old", undefined],
		]);
		expect(read.unreadable.sort()).toEqual([pinKey("bad"), pinKey("legacy")]);
	});

	it("downloads a pin once, and again after it is rewritten", async () => {
		const storage = new RevalidatingStorage();
		const pinned = manifestOf("p", null, { a: "A" });
		await pinSnapshot(storage, key, pinned, "One");
		const get = vi.spyOn(storage, "get");
		const pinGets = (): number =>
			get.mock.calls.filter(([got]) => got === pinKey("p")).length;

		await readPins(storage, key, "", () => null);
		await readPins(storage, key, "", () => null);
		expect(pinGets()).toBe(1);

		await pinSnapshot(storage, key, pinned, "Two");
		const read = await readPins(storage, key, "", () => null);
		expect(read.pins[0]?.info.label).toBe("Two");
		expect(pinGets()).toBe(2);
	});

	it("downloads every time without an etag: a timestamp may not move on a rewrite", async () => {
		const storage = new FakeStorage();
		await pinSnapshot(storage, key, manifestOf("p", null, {}));
		const get = vi.spyOn(storage, "get");

		await readPins(storage, key, "", () => null);
		await readPins(storage, key, "", () => null);
		expect(get).toHaveBeenCalledTimes(2);
	});

	it("stores a share's pin in space paths and reads it back in vault paths", async () => {
		const storage = new FakeStorage();
		const pinned = manifestOf("p", null, { "Shared/p/a.md": "A" });
		await writePin(storage, key, "Shared/p", {
			id: "p",
			manifest: pinned,
			pinnedAt: 1,
		});

		const raw = await decryptJson<{ manifest: Manifest }>(
			key,
			(await storage.get(pinKey("p"))) as Uint8Array,
		);
		expect(Object.keys(raw.manifest.files)).toEqual(["a.md"]);
		const pin = await readPinById(storage, key, "Shared/p", "p");
		expect(Object.keys(pin?.manifest.files ?? {})).toEqual(["Shared/p/a.md"]);
	});
});
