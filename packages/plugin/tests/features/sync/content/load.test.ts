import {
	bytesOf,
	compressedDrawing,
	plainDrawing,
} from "@tests/helpers/drawing-file";
import { FakeStorage } from "@tests/helpers/fake-storage";
import {
	concat,
	putChunked,
	putChunks,
	putRecipe,
} from "@tests/helpers/recipes";
import { seeded } from "@tests/helpers/seeded";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	deriveChunkIds,
	deriveKey,
	type EncryptionKey,
	encryptBytes,
	encryptCompressible,
	encryptDescribed,
	sha256Hex,
} from "@/core/crypto";
import { encodeDrawing } from "@/core/drawing";
import {
	CHUNK_THRESHOLD,
	chunkKey,
	objectKey,
	recipeKey,
} from "@/features/sync/content/keys";
import {
	ContentError,
	loadContent,
	prepareContent,
} from "@/features/sync/content/load";
import { storeContent } from "@/features/sync/content/store";

let key: EncryptionKey;
beforeAll(async () => {
	key = await deriveKey("pw", new Uint8Array(16));
});

async function put(
	storage: FakeStorage,
	bytes: Uint8Array,
	blob: Uint8Array,
): Promise<string> {
	const hash = await sha256Hex(bytes);
	await storage.put(objectKey(hash), blob);
	return hash;
}

function drawing() {
	const bytes = bytesOf(compressedDrawing());
	const encoded = encodeDrawing(bytes);
	if (!encoded) throw new Error("fixture does not encode");
	return { bytes, ...encoded };
}

describe("loadContent", () => {
	it("reads a 0x01 blob", async () => {
		const storage = new FakeStorage();
		const bytes = bytesOf("a plain note");
		const hash = await put(storage, bytes, await encryptBytes(key, bytes));
		expect(await loadContent({ storage, key }, hash)).toEqual(bytes);
	});

	it("reads a 0x02 blob", async () => {
		const storage = new FakeStorage();
		const bytes = bytesOf("a long note. ".repeat(2000));
		const blob = await encryptCompressible(key, bytes);
		expect(blob[0]).toBe(0x02);
		const hash = await put(storage, bytes, blob);
		expect(await loadContent({ storage, key }, hash)).toEqual(bytes);
	});

	it("rebuilds a drawing from a described codec blob, byte for byte", async () => {
		const storage = new FakeStorage();
		const { bytes, stored, codec } = drawing();
		const blob = await encryptDescribed(key, { codec }, stored);
		expect(blob[0]).toBe(0x03);
		const hash = await put(storage, bytes, blob);
		expect(await loadContent({ storage, key }, hash)).toEqual(bytes);
	});

	it("reads a described blob with no codec as the payload itself", async () => {
		const storage = new FakeStorage();
		const bytes = bytesOf(plainDrawing());
		const hash = await put(
			storage,
			bytes,
			await encryptDescribed(key, {}, bytes),
		);
		expect(await loadContent({ storage, key }, hash)).toEqual(bytes);
	});

	it("is null only for an absent object, and passes the size on", async () => {
		const storage = new FakeStorage();
		expect(await loadContent({ storage, key }, "f".repeat(64))).toBeNull();
		const sizes: Array<number | undefined> = [];
		const get = storage.get.bind(storage);
		storage.get = (path: string, size?: number) => {
			sizes.push(size);
			return get(path);
		};
		await loadContent({ storage, key }, "e".repeat(64), 1234);
		expect(sizes).toEqual([1234]);
	});

	it("refuses an unknown codec name: wrong bytes are never returned", async () => {
		const storage = new FakeStorage();
		const { bytes, stored, codec } = drawing();
		const blob = await encryptDescribed(
			key,
			{ codec: { ...codec, name: "future-codec" } },
			stored,
		);
		const hash = await put(storage, bytes, blob);
		await expect(loadContent({ storage, key }, hash)).rejects.toThrow(
			/Unknown content codec/,
		);
	});

	it("refuses a header with a chunks field, even beside a good codec", async () => {
		const storage = new FakeStorage();
		const { bytes, stored, codec } = drawing();
		for (const header of [
			{ chunks: [["a".repeat(64), 10]] },
			{ codec, chunks: [] },
		]) {
			const hash = await put(
				storage,
				bytes,
				await encryptDescribed(key, header, stored),
			);
			await expect(loadContent({ storage, key }, hash)).rejects.toThrow(
				/Unreadable chunk list/,
			);
		}
	});

	it("refuses an unknown header shape", async () => {
		const storage = new FakeStorage();
		const { bytes, stored, codec } = drawing();
		const odd: unknown[] = [
			{ other: 1 },
			{ codec, other: 1 },
			{ codec: null },
			{ codec: { name: "excalidraw-lz", width: "256", gap: "\n\n" } },
			{ codec: { ...codec, width: 0 } },
			{ codec: { ...codec, extra: true } },
			[1, 2],
			"text",
			null,
		];
		for (const header of odd) {
			const hash = await put(
				storage,
				bytes,
				await encryptDescribed(key, header as object, stored),
			);
			await expect(loadContent({ storage, key }, hash)).rejects.toThrow(
				/Unreadable content header|Unknown content/,
			);
		}
	});

	it("refuses a rebuilt file that does not hash to its name", async () => {
		const storage = new FakeStorage();
		const { bytes, stored, codec } = drawing();
		// Same scene, another width: decodes cleanly into a different file.
		const wrongWidth = await encryptDescribed(
			key,
			{ codec: { ...codec, width: 100 } },
			stored,
		);
		const hash = await put(storage, bytes, wrongWidth);
		await expect(loadContent({ storage, key }, hash)).rejects.toThrow(
			/Hash mismatch/,
		);

		const other = bytesOf("something else");
		const named = await put(
			storage,
			bytes,
			await encryptDescribed(key, {}, other),
		);
		await expect(loadContent({ storage, key }, named)).rejects.toThrow(
			/Hash mismatch/,
		);
	});

	it("keeps the hash mismatch error for a plain blob", async () => {
		const storage = new FakeStorage();
		const hash = await put(
			storage,
			bytesOf("real"),
			await encryptBytes(key, bytesOf("tampered")),
		);
		await expect(loadContent({ storage, key }, hash)).rejects.toThrow(
			`Hash mismatch for remote object ${hash}`,
		);
	});

	it("throws on a corrupt blob rather than returning null", async () => {
		const storage = new FakeStorage();
		const bytes = bytesOf("note");
		const blob = await encryptBytes(key, bytes);
		blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 1;
		const hash = await put(storage, bytes, blob);
		await expect(loadContent({ storage, key }, hash)).rejects.toThrow();
	});
});

describe("loadContent, chunked", () => {
	const parts = [bytesOf("first part, "), bytesOf("second, "), bytesOf("last")];
	const bytes = concat(parts);
	const BIG = CHUNK_THRESHOLD;

	it("joins the chunks a recipe names, looking under recipes/ first for a big file", async () => {
		const storage = new FakeStorage();
		const hash = await putChunked(storage, key, parts);
		const get = vi.spyOn(storage, "get");

		expect(await loadContent({ storage, key }, hash, BIG)).toEqual(bytes);
		expect(get.mock.calls[0]?.[0]).toBe(recipeKey(hash));
		expect(get).not.toHaveBeenCalledWith(objectKey(hash), BIG);
	});

	it("finds a big file stored whole, and a recipe when the size is unknown", async () => {
		const storage = new FakeStorage();
		const whole = bytesOf("uploaded before chunking");
		const hash = await put(storage, whole, await encryptBytes(key, whole));
		expect(await loadContent({ storage, key }, hash, BIG)).toEqual(whole);

		const chunked = await putChunked(storage, key, parts);
		expect(await loadContent({ storage, key }, chunked)).toEqual(bytes);
		expect(await loadContent({ storage, key }, chunked, 10)).toBeNull();
	});

	it("rebuilds a chunked drawing", async () => {
		const storage = new FakeStorage();
		const { bytes: file, stored, codec } = drawing();
		const half = Math.floor(stored.length / 2);
		await putChunks(storage, key, {
			d0: stored.subarray(0, half),
			d1: stored.subarray(half),
		});
		const hash = await sha256Hex(file);
		const sizes: [string, number][] = [
			["d0", half],
			["d1", stored.length - half],
		];
		await putRecipe(storage, key, hash, sizes, codec);
		expect(await loadContent({ storage, key }, hash)).toEqual(file);
	});

	it("throws, never null, on a missing chunk or one of the wrong size", async () => {
		const storage = new FakeStorage();
		const hash = await putChunked(storage, key, parts);
		await storage.put(chunkKey("c1"), await encryptBytes(key, bytesOf("x")));
		await expect(loadContent({ storage, key }, hash)).rejects.toThrow(
			/wrong size/,
		);

		await storage.delete(chunkKey("c1"));
		await expect(loadContent({ storage, key }, hash)).rejects.toThrow(
			ContentError,
		);
	});

	it("refuses a recipe that is no recipe: a plain blob, a payload beside chunks, no chunks", async () => {
		const storage = new FakeStorage();
		const hash = await putChunked(storage, key, parts);
		const chunks = { chunks: [["c0", parts[0]?.length]] };
		for (const blob of [
			await encryptBytes(key, bytes),
			await encryptDescribed(key, chunks, bytesOf("payload")),
			await encryptDescribed(key, {}, bytes),
		]) {
			await storage.put(recipeKey(hash), blob);
			await expect(loadContent({ storage, key }, hash)).rejects.toThrow(
				ContentError,
			);
		}
	});

	it("refuses joined chunks that do not hash to the name", async () => {
		const storage = new FakeStorage();
		await putChunks(storage, key, { x: bytesOf("other") });
		await putRecipe(storage, key, "a".repeat(64), [["x", 5]]);
		await expect(loadContent({ storage, key }, "a".repeat(64))).rejects.toThrow(
			/Hash mismatch/,
		);
	});
});

describe("prepareContent", () => {
	class HintedStorage extends FakeStorage {
		readonly hints: string[][] = [];

		prepareReads(keys: string[]): void {
			this.hints.push(keys);
		}
	}

	it("hints roots, then roots and the chunks big files name, and reads each recipe once", async () => {
		const storage = new HintedStorage();
		const parts = [bytesOf("one "), bytesOf("two")];
		const big = await putChunked(storage, key, parts);
		const legacy = bytesOf("big, stored whole");
		const whole = await put(storage, legacy, await encryptBytes(key, legacy));
		const small = await put(
			storage,
			bytesOf("s"),
			await encryptBytes(key, bytesOf("s")),
		);
		const source = { storage, key };
		const entries = [
			{ hash: big, size: CHUNK_THRESHOLD },
			{ hash: whole, size: CHUNK_THRESHOLD },
			{ hash: small, size: 1 },
		];
		const roots = [
			recipeKey(big),
			objectKey(big),
			recipeKey(whole),
			objectKey(whole),
			objectKey(small),
		];

		await prepareContent(source, entries);
		expect(storage.hints).toEqual([
			roots,
			[...roots, chunkKey("c0"), chunkKey("c1")],
		]);

		const get = vi.spyOn(storage, "get");
		expect(await loadContent(source, big, CHUNK_THRESHOLD)).toEqual(
			concat(parts),
		);
		expect(await loadContent(source, whole, CHUNK_THRESHOLD)).toEqual(legacy);
		const read = get.mock.calls.map(([storageKey]) => storageKey);
		expect(read).not.toContain(recipeKey(big));

		// Taken once: a second load reads again.
		await loadContent(source, big, CHUNK_THRESHOLD);
		expect(get).toHaveBeenCalledWith(recipeKey(big), CHUNK_THRESHOLD);
	});
});

describe("loadContent, with a local copy", () => {
	const SIZE = 600 * 1024;
	let chunkIds: CryptoKey;
	beforeAll(async () => {
		chunkIds = await deriveChunkIds(new Uint8Array(32).fill(5));
	});

	function random(seed: number): Uint8Array {
		const next = seeded(seed);
		return new Uint8Array(SIZE).map(() => Math.floor(next() * 256));
	}

	/** v2 stored chunked; v1 is what the disk holds. */
	async function versions() {
		const storage = new FakeStorage();
		const v1 = random(1);
		const v2 = v1.slice();
		v2.set(bytesOf("an edit in the middle"), SIZE / 2);
		const h2 = await sha256Hex(v2);
		await storeContent({ storage, key, chunkIds }, h2, v2);
		const all = (await storage.list("chunks/")).length;
		const gets = vi.spyOn(storage, "get");
		const chunkGets = () =>
			gets.mock.calls.filter(([at]) => at.startsWith("chunks/")).length;
		return { storage, v1, v2, h2, all, chunkGets };
	}

	it("downloads only the chunks the local copy lacks", async () => {
		const { storage, v1, v2, h2, chunkGets } = await versions();
		const loaded = await loadContent(
			{ storage, key, chunkIds },
			h2,
			SIZE,
			async () => v1,
		);
		expect(loaded).toEqual(v2);
		expect(chunkGets()).toBeLessThanOrEqual(2);
	});

	it("downloads every chunk without a chunk key, or when the copy does not read", async () => {
		const { storage, v1, v2, h2, all, chunkGets } = await versions();
		expect(
			await loadContent({ storage, key }, h2, SIZE, async () => v1),
		).toEqual(v2);
		expect(chunkGets()).toBe(all);

		const failing = async (): Promise<Uint8Array> => {
			throw new Error("locked");
		};
		expect(
			await loadContent({ storage, key, chunkIds }, h2, SIZE, failing),
		).toEqual(v2);
		expect(chunkGets()).toBe(2 * all);
	});
});
