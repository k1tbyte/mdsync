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
	readPinInfos,
	readPins,
	writePin,
} from "@/features/sync/history/pins";
import {
	resolveSnapshotManifest,
	setSnapshotPinned,
} from "@/features/sync/history/query";
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

	it("leaves the configuration folder out of a new pin, and keeps the vault files", async () => {
		const storage = new FakeStorage();
		const withConfig = [
			manifestOf("c1", null, { "a.md": "A1" }),
			manifestOf("c2", "c1", {
				"a.md": "A2",
				".obsidian/app.json": "J1",
				".obsidian-other/x": "O1",
			}),
			manifestOf("c3", "c2", { "a.md": "A3" }),
		];
		await seedChain(storage, key, withConfig);

		await setSnapshotPinned(
			{ storage, key, root: "", configDir: ".obsidian" },
			"c2",
			true,
		);

		const pin = await readPinById(storage, key, "", "c2");
		expect(Object.keys(pin?.manifest.files ?? {}).sort()).toEqual([
			".obsidian-other/x",
			"a.md",
		]);
		expect(pin?.manifest.files["a.md"]).toEqual(withConfig[1]?.files["a.md"]);
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

	it("reads the pin once when history cannot rebuild the snapshot", async () => {
		const storage = await seeded();
		await storage.delete(pushKey("s2"));
		const get = vi.spyOn(storage, "get");

		await expect(
			setSnapshotPinned({ storage, key, root: "" }, "s1", true),
		).rejects.toThrow(/can no longer be rebuilt/);
		expect(get.mock.calls.filter(([got]) => got === pinKey("s1"))).toHaveLength(
			1,
		);
	});
});

describe("resolveSnapshotManifest", () => {
	it("falls back to the pin once replay cannot reach the snapshot", async () => {
		const storage = await seeded();
		const source = { storage, key, root: "" };
		await setSnapshotPinned(source, "s1", true);
		await storage.delete(pushKey("s2"));

		expect((await resolveSnapshotManifest(source, "s1"))?.files).toEqual(
			chain[0]?.files,
		);
		expect(await resolveSnapshotManifest(source, "s2")).toBeNull();
	});
});

async function pinMany(storage: FakeStorage, count: number): Promise<void> {
	for (let i = 0; i < count; i++) {
		await pinSnapshot(storage, key, manifestOf(`p${i}`, null, {}, i + 1));
	}
}

describe("readPinInfos", () => {
	it("downloads no pin again while its etag holds, past the manifest cache", async () => {
		const storage = new RevalidatingStorage();
		await pinMany(storage, 6);
		const get = vi.spyOn(storage, "get");

		const first = await readPinInfos(storage, key, "");
		expect(get).toHaveBeenCalledTimes(6);
		get.mockClear();
		const second = await readPinInfos(storage, key, "");
		expect(get).not.toHaveBeenCalled();
		expect(second).toEqual(first);
		expect(second.pins.map(({ id }) => id)).toEqual([
			"p5",
			"p4",
			"p3",
			"p2",
			"p1",
			"p0",
		]);
	});

	it("reads again only the pin whose etag changed", async () => {
		const storage = new RevalidatingStorage();
		await pinMany(storage, 6);
		await readPinInfos(storage, key, "");
		await pinSnapshot(storage, key, manifestOf("p2", null, {}, 3), "Renamed");
		const get = vi.spyOn(storage, "get");

		const read = await readPinInfos(storage, key, "");
		expect(get.mock.calls).toEqual([[pinKey("p2")]]);
		expect(read.pins.find(({ id }) => id === "p2")?.label).toBe("Renamed");
	});

	it("drops a pin that is no longer listed", async () => {
		const storage = new RevalidatingStorage();
		await pinMany(storage, 6);
		await readPinInfos(storage, key, "");
		await storage.delete(pinKey("p3"));
		const get = vi.spyOn(storage, "get");

		const read = await readPinInfos(storage, key, "");
		expect(read.pins.map(({ id }) => id)).not.toContain("p3");
		expect(read.pins).toHaveLength(5);
		expect(get).not.toHaveBeenCalled();
	});

	it("reads every pin again without an etag, and keeps naming an unreadable one", async () => {
		const storage = new FakeStorage();
		await pinMany(storage, 6);
		await storage.put(pinKey("bad"), new Uint8Array([1]));
		const get = vi.spyOn(storage, "get");

		await readPinInfos(storage, key, "");
		const read = await readPinInfos(storage, key, "");
		expect(get).toHaveBeenCalledTimes(14);
		expect(read.pins).toHaveLength(6);
		expect(read.unreadable).toEqual([pinKey("bad")]);
	});

	it("is warmed by readPins", async () => {
		const storage = new RevalidatingStorage();
		await pinMany(storage, 6);
		await readPins(storage, key, "", () => null);
		const get = vi.spyOn(storage, "get");

		await readPinInfos(storage, key, "");
		expect(get).not.toHaveBeenCalled();
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

	it("skips a pin unpinned between its listing and its read", async () => {
		const storage = new FakeStorage();
		await pinSnapshot(storage, key, manifestOf("kept", null, {}, 1));
		await pinSnapshot(storage, key, manifestOf("gone", null, {}, 2));
		const get = storage.get.bind(storage);
		vi.spyOn(storage, "get").mockImplementation(async (storageKey) =>
			storageKey === pinKey("gone") ? null : get(storageKey),
		);

		const read = await readPins(storage, key, "", () => null);
		expect(read.pins.map(({ info }) => info.id)).toEqual(["kept"]);
		expect(read.unreadable).toEqual([]);
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

	it("keeps every pin of a small vault, so a second read downloads none", async () => {
		const storage = new RevalidatingStorage();
		await pinMany(storage, 6);
		await readPins(storage, key, "", () => null);
		const get = vi.spyOn(storage, "get");

		const read = await readPins(storage, key, "", () => null);
		expect(read.pins).toHaveLength(6);
		expect(get).not.toHaveBeenCalled();
	});

	it("drops the manifest of a pin that is no longer listed", async () => {
		const storage = new RevalidatingStorage();
		await pinMany(storage, 3);
		await readPins(storage, key, "", () => null);
		const list = storage.listDetailed.bind(storage);
		vi.spyOn(storage, "listDetailed").mockImplementationOnce(async (prefix) =>
			(await list(prefix)).filter((object) => object.key !== pinKey("p1")),
		);
		await readPins(storage, key, "", () => null);
		const get = vi.spyOn(storage, "get");

		// Listed again with the etag it had: a manifest held meanwhile would answer without a GET.
		await readPins(storage, key, "", () => null);
		expect(get.mock.calls).toEqual([[pinKey("p1")]]);
	});

	describe("past the cache bound", () => {
		// Two of these are past the 200k file entries the cache holds; one alone is under it.
		const big = (id: string, createdAt: number, count = 110_000): Manifest =>
			manifestOf(
				id,
				null,
				Object.fromEntries(
					Array.from({ length: count }, (_, i) => [`${id}/${i}`, `h${i}`]),
				),
				createdAt,
			);

		it("drops the oldest read first and keeps the rest", async () => {
			const storage = new RevalidatingStorage();
			await pinSnapshot(storage, key, big("big1", 1));
			await readPins(storage, key, "", () => null);
			await pinSnapshot(storage, key, big("big2", 2));
			await readPins(storage, key, "", () => null);
			const get = vi.spyOn(storage, "get");

			await readPins(storage, key, "", () => null);
			expect(get.mock.calls).toEqual([[pinKey("big1")]]);
		});

		it("keeps the pin just read even when it alone is past the bound", async () => {
			const storage = new RevalidatingStorage();
			await pinSnapshot(storage, key, big("huge", 1, 200_001));
			await readPins(storage, key, "", () => null);
			const get = vi.spyOn(storage, "get");

			await readPins(storage, key, "", () => null);
			expect(get).not.toHaveBeenCalled();
		});
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
