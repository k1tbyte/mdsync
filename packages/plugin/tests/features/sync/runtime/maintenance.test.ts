import { bytesOf, compressedDrawing } from "@tests/helpers/drawing-file";
import { FakeStorage } from "@tests/helpers/fake-storage";
import {
	manifestOf,
	pinSnapshot,
	seedChain,
	writePushRecord,
} from "@tests/helpers/history";
import { publishManifest } from "@tests/helpers/manifest";
import { putChunked } from "@tests/helpers/recipes";
import { beforeAll, describe, expect, it } from "vitest";
import {
	deriveKey,
	type EncryptionKey,
	encryptBytes,
	encryptDescribed,
	encryptJson,
	sha256Hex,
} from "@/core/crypto/cipher";
import { encodeDrawing } from "@/core/drawing";
import {
	REMOTE_OBJECTS_PREFIX,
	REMOTE_PINS_PREFIX,
} from "@/features/sync/constants";
import {
	CHUNK_THRESHOLD,
	chunkKey,
	objectKey,
} from "@/features/sync/content/keys";
import { storeContent } from "@/features/sync/content/store";
import {
	deepCleanOrphans,
	verifyRemote,
} from "@/features/sync/runtime/maintenance";
import type { Manifest } from "@/features/sync/types";

const DAY_MS = 24 * 60 * 60 * 1000;

let key: EncryptionKey;
beforeAll(async () => {
	key = await deriveKey("pw", new Uint8Array(16));
});

describe("verifyRemote", () => {
	it("passes on a complete remote and flags a missing object", async () => {
		const storage = new FakeStorage();
		const head = manifestOf("s1", null, { "a.md": "H1" });
		await publishManifest(storage, key, head);
		await storage.put(objectKey("H1"), new Uint8Array([1]));

		const ok = await verifyRemote(storage, key, "", false);
		expect(ok.checked).toBe(1);
		expect(ok.missing).toHaveLength(0);

		await storage.delete(objectKey("H1"));
		const bad = await verifyRemote(storage, key, "", false);
		expect(bad.missing).toEqual(["H1"]);
	});

	it("announces every object read before the first get", async () => {
		const calls: string[] = [];
		class PreparingStorage extends FakeStorage {
			prepareReads(keys: string[]): void {
				calls.push(`prepare:${[...keys].sort().join(",")}`);
			}
			override get(path: string): Promise<Uint8Array | null> {
				if (path.startsWith(REMOTE_OBJECTS_PREFIX)) calls.push("get");
				return super.get(path);
			}
		}
		const storage = new PreparingStorage();
		await publishManifest(
			storage,
			key,
			manifestOf("s1", null, { "a.md": "H1", "b.md": "H2" }),
		);
		await storage.put(objectKey("H1"), new Uint8Array([1]));
		await storage.put(objectKey("H2"), new Uint8Array([1]));

		await verifyRemote(storage, key, "", false);
		expect(calls[0]).toBe(`prepare:${objectKey("H1")},${objectKey("H2")}`);
		expect(calls.filter((c) => c === "get")).toHaveLength(2);
	});
});

describe("verifyRemote, deep", () => {
	async function remoteWith(
		blobFor: (bytes: Uint8Array) => Promise<Uint8Array>,
	) {
		const storage = new FakeStorage();
		const bytes = bytesOf(compressedDrawing());
		const hash = await sha256Hex(bytes);
		await publishManifest(
			storage,
			key,
			manifestOf("s1", null, { "a.excalidraw.md": hash }),
		);
		await storage.put(objectKey(hash), await blobFor(bytes));
		return { storage, hash };
	}

	it("verifies a described root clean", async () => {
		const { storage } = await remoteWith(async (bytes) => {
			const probe = new FakeStorage();
			await storeContent(
				{ storage: probe, key },
				await sha256Hex(bytes),
				bytes,
			);
			const blob = probe.map.get(objectKey(await sha256Hex(bytes)));
			expect(blob?.[0]).toBe(0x03);
			return blob as Uint8Array;
		});

		expect(await verifyRemote(storage, key, "", true)).toEqual({
			checked: 1,
			missing: [],
			corrupt: [],
		});
	});

	it("flags a described root whose rebuilt bytes do not hash to its name", async () => {
		const { storage, hash } = await remoteWith(async (bytes) => {
			const encoded = encodeDrawing(bytes);
			if (!encoded) throw new Error("fixture does not encode");
			return encryptDescribed(
				key,
				{ codec: { ...encoded.codec, width: 64 } },
				encoded.stored,
			);
		});

		const result = await verifyRemote(storage, key, "", true);
		expect(result.corrupt).toEqual([hash]);
		expect(result.missing).toEqual([]);
		// Shallow verify only checks that the object exists.
		expect((await verifyRemote(storage, key, "", false)).corrupt).toEqual([]);
	});

	it("flags a described root with an unknown codec, and still reports a missing one", async () => {
		const { storage, hash } = await remoteWith((bytes) =>
			encryptDescribed(
				key,
				{ codec: { name: "future", width: 256, gap: "\n\n" } },
				bytes,
			),
		);
		expect((await verifyRemote(storage, key, "", true)).corrupt).toEqual([
			hash,
		]);

		await storage.delete(objectKey(hash));
		expect((await verifyRemote(storage, key, "", true)).missing).toEqual([
			hash,
		]);
	});
});

describe("verifyRemote, chunked", () => {
	async function chunkedRemote() {
		const storage = new FakeStorage();
		const hash = await putChunked(storage, key, [bytesOf("ab"), bytesOf("cd")]);
		const head = manifestOf("s1", null, { "big.bin": hash });
		(head.files["big.bin"] as { size: number }).size = CHUNK_THRESHOLD;
		await publishManifest(storage, key, head);
		return { storage, hash };
	}

	it("passes a complete chunked file, shallow and deep", async () => {
		const { storage } = await chunkedRemote();
		for (const deep of [false, true]) {
			expect(await verifyRemote(storage, key, "", deep)).toEqual({
				checked: 1,
				missing: [],
				corrupt: [],
			});
		}
	});

	it("flags a missing chunk as missing, shallow and deep", async () => {
		const { storage, hash } = await chunkedRemote();
		await storage.delete(chunkKey("c1"));
		for (const deep of [false, true]) {
			const result = await verifyRemote(storage, key, "", deep);
			expect(result.missing).toEqual([hash]);
			expect(result.corrupt).toEqual([]);
		}
	});

	it("flags a chunk with other bytes only when deep", async () => {
		const { storage, hash } = await chunkedRemote();
		await storage.put(chunkKey("c1"), await encryptBytes(key, bytesOf("xy")));
		expect((await verifyRemote(storage, key, "", false)).corrupt).toEqual([]);
		expect((await verifyRemote(storage, key, "", true)).corrupt).toEqual([
			hash,
		]);
	});

	it("aborts on a failed chunk read instead of calling it corrupt", async () => {
		const { storage } = await chunkedRemote();
		const get = storage.get.bind(storage);
		storage.get = (storageKey) =>
			storageKey === chunkKey("c1")
				? Promise.reject(new Error("offline"))
				: get(storageKey);
		await expect(verifyRemote(storage, key, "", true)).rejects.toThrow(
			"offline",
		);
	});
});

async function putObjects(
	storage: FakeStorage,
	...hashes: string[]
): Promise<void> {
	for (const hash of hashes) {
		await storage.put(objectKey(hash), new Uint8Array([1]));
	}
}

describe("deepCleanOrphans", () => {
	it("removes unreachable blobs, keeps those HEAD, a push record or a pin names", async () => {
		const storage = new FakeStorage();
		const chain = [
			manifestOf("s1", null, { "a.md": "H1", "b.md": "B1" }),
			manifestOf("s2", "s1", { "a.md": "H2" }),
		];
		await seedChain(storage, key, chain);
		await pinSnapshot(storage, key, manifestOf("p", null, { "c.md": "P1" }));
		await putObjects(storage, "H1", "H2", "B1", "P1", "ORPHAN");
		await storage.put(`${REMOTE_OBJECTS_PREFIX}stray`, new Uint8Array([9]));
		storage.age(DAY_MS + 1);

		const res = await deepCleanOrphans(storage, key, "");
		expect(res.deletedObjects).toBe(2);
		for (const hash of ["H1", "H2", "B1", "P1"]) {
			expect(await storage.exists(objectKey(hash))).toBe(true);
		}
		expect(await storage.exists(objectKey("ORPHAN"))).toBe(false);
		expect((await deepCleanOrphans(storage, key, "")).deletedObjects).toBe(0);
	});

	it("refuses a HEAD below the fence: 1.x clients still sync and name what looks orphaned", async () => {
		const storage = new FakeStorage();
		await publishManifest(storage, key, {
			...manifestOf("s1", null, { "a.md": "H1" }),
			version: 2,
		});
		await putObjects(storage, "H1", "OLD");
		storage.age(DAY_MS + 1);

		await expect(deepCleanOrphans(storage, key, "")).rejects.toThrow(
			/old file history format/,
		);
		expect(await storage.exists(objectKey("OLD"))).toBe(true);
	});

	it("refuses while a history record or pin cannot be read", async () => {
		const storage = new FakeStorage();
		await seedChain(storage, key, [manifestOf("s1", null, { "a.md": "H1" })]);
		await putObjects(storage, "H1", "ORPHAN");
		// A 1.x pin is a bare manifest: unreadable until the post-push cleanup deletes it.
		await storage.put(
			`${REMOTE_PINS_PREFIX}s0.json.enc`,
			await encryptJson(key, manifestOf("s0", null, { "a.md": "ORPHAN" })),
		);
		storage.age(DAY_MS + 1);

		await expect(deepCleanOrphans(storage, key, "")).rejects.toThrow(
			/could not be read/,
		);
		await expect(verifyRemote(storage, key, "", false)).rejects.toThrow(
			/could not be read/,
		);
		expect(await storage.exists(objectKey("ORPHAN"))).toBe(true);
	});

	it("keeps what was written in the last day: another device's push not yet published", async () => {
		const storage = new FakeStorage();
		await seedChain(storage, key, [manifestOf("s1", null, { "a.md": "H1" })]);
		await putObjects(storage, "H1", "OLD");
		storage.age(DAY_MS + 1);
		await putObjects(storage, "UPLOADING");

		expect(await deepCleanOrphans(storage, key, "")).toEqual({
			deletedObjects: 1,
		});
		expect(await storage.exists(objectKey("OLD"))).toBe(false);
		expect(await storage.exists(objectKey("UPLOADING"))).toBe(true);
	});

	it("needs a published HEAD", async () => {
		const storage = new FakeStorage();
		await putObjects(storage, "ORPHAN");
		storage.age(DAY_MS + 1);
		await expect(deepCleanOrphans(storage, key, "")).rejects.toThrow(
			/No manifest/,
		);
	});
});

describe("deepCleanOrphans concurrency", () => {
	class RacingStorage extends FakeStorage {
		raceOnce: (() => Promise<void>) | null = null;
		override async listDetailed(prefix: string) {
			const listed = await super.listDetailed(prefix);
			const race = prefix === REMOTE_OBJECTS_PREFIX ? this.raceOnce : null;
			if (race) {
				this.raceOnce = null;
				await race();
			}
			return listed;
		}
	}

	it("bails when another device pins a snapshot while it lists", async () => {
		// Pinning does not move HEAD, so only a pin listing catches it.
		const storage = new RacingStorage();
		const chain = [
			manifestOf("s1", null, { "a.md": "H1" }),
			manifestOf("s2", "s1", { "a.md": "H2" }),
		];
		await seedChain(storage, key, chain);
		await putObjects(storage, "H1", "H2");
		storage.age(DAY_MS + 1);
		storage.raceOnce = () => pinSnapshot(storage, key, chain[0] as Manifest);

		await expect(deepCleanOrphans(storage, key, "")).rejects.toThrow(
			/pinned snapshot while cleaning/,
		);
	});

	it("bails when a record retried by another device appears while it lists", async () => {
		const storage = new RacingStorage();
		const s1 = manifestOf("s1", null, { "a.md": "A1" });
		const s2 = manifestOf("s2", "s1", {});
		// Both record writes failed: only their retry names A1.
		await seedChain(storage, key, [s1, s2], ["s1", "s2"]);
		await putObjects(storage, "A1");
		storage.age(DAY_MS + 1);
		storage.raceOnce = () => writePushRecord(storage, key, s1, null);

		await expect(deepCleanOrphans(storage, key, "")).rejects.toThrow(
			/wrote file history while cleaning/,
		);
		expect(await storage.exists(objectKey("A1"))).toBe(true);
	});

	it("bails when another device pushes while it lists", async () => {
		const storage = new RacingStorage();
		const head = manifestOf("s1", null, { "a.md": "H1" });
		await seedChain(storage, key, [head]);
		await putObjects(storage, "H1");
		storage.age(DAY_MS + 1);
		storage.raceOnce = () =>
			publishManifest(storage, key, manifestOf("s2", "s1", { "a.md": "H1" }));

		await expect(deepCleanOrphans(storage, key, "")).rejects.toThrow(
			/pushed while cleaning/,
		);
	});
});
