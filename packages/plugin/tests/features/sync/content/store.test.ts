import {
	bytesOf,
	compressedDrawing,
	plainDrawing,
} from "@tests/helpers/drawing-file";
import { FakeStorage } from "@tests/helpers/fake-storage";
import { seeded } from "@tests/helpers/seeded";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	decryptDescribed,
	deriveChunkIds,
	deriveKey,
	type EncryptionKey,
	encryptCompressible,
	sha256Hex,
} from "@/core/crypto";
import {
	CHUNK_THRESHOLD,
	objectKey,
	recipeKey,
} from "@/features/sync/content/keys";
import { loadContent } from "@/features/sync/content/load";
import { storeContent } from "@/features/sync/content/store";

let key: EncryptionKey;
let chunkIds: CryptoKey;
beforeAll(async () => {
	key = await deriveKey("pw", new Uint8Array(16));
	chunkIds = await deriveChunkIds(new Uint8Array(32).fill(7));
});
afterEach(() => vi.unstubAllGlobals());

async function store(bytes: Uint8Array) {
	const storage = new FakeStorage();
	const hash = await sha256Hex(bytes);
	await storeContent({ storage, key }, hash, bytes);
	const blob = storage.map.get(objectKey(hash));
	if (!blob) throw new Error("nothing stored");
	return { storage, hash, blob };
}

describe("storeContent", () => {
	it("stores a compressed drawing described, and loads it back byte for byte", async () => {
		const bytes = bytesOf(compressedDrawing());
		const { storage, hash, blob } = await store(bytes);

		expect(blob[0]).toBe(0x03);
		const { header } = await decryptDescribed(key, blob);
		expect(header).toEqual({
			codec: { name: "excalidraw-lz", width: 256, gap: "\n\n" },
		});
		expect(await loadContent({ storage, key }, hash)).toEqual(bytes);
	});

	it("stores a note as before", async () => {
		const bytes = bytesOf("# note\n\n".repeat(900));
		const { storage, hash, blob } = await store(bytes);

		expect(blob[0]).toBe(0x02);
		expect(blob.length).toBe((await encryptCompressible(key, bytes)).length);
		expect(await loadContent({ storage, key }, hash)).toEqual(bytes);

		const small = await store(bytesOf("hi"));
		expect(small.blob[0]).toBe(0x01);
		expect(
			await loadContent({ storage: small.storage, key }, small.hash),
		).toEqual(bytesOf("hi"));
	});

	it("stores a drawing with a plain scene as before", async () => {
		const bytes = bytesOf(plainDrawing());
		const { storage, hash, blob } = await store(bytes);
		expect(blob[0]).not.toBe(0x03);
		expect(await loadContent({ storage, key }, hash)).toEqual(bytes);
	});

	it("stores binary content as before", async () => {
		const bytes = new Uint8Array(5000).map((_, at) => (at * 7919) % 256);
		const { storage, hash, blob } = await store(bytes);
		expect(blob[0]).not.toBe(0x03);
		expect(await loadContent({ storage, key }, hash)).toEqual(bytes);
	});

	it("stores a drawing whole when this device cannot compress", async () => {
		vi.stubGlobal("CompressionStream", undefined);
		const bytes = bytesOf(compressedDrawing());
		const { storage, hash, blob } = await store(bytes);
		expect(blob[0]).toBe(0x01);
		expect(await loadContent({ storage, key }, hash)).toEqual(bytes);
	});

	it("shrinks a drawing's sealed blob against storing its compressed block", async () => {
		const bytes = bytesOf(compressedDrawing());
		const { blob } = await store(bytes);
		const whole = await encryptCompressible(key, bytes);
		expect(blob.length).toBeLessThan(whole.length);
	});
});

describe("storeContent, chunked", () => {
	const SIZE = 600 * 1024;

	function random(size: number, seed = 1): Uint8Array {
		const next = seeded(seed);
		return new Uint8Array(size).map(() => Math.floor(next() * 256));
	}

	function edited(bytes: Uint8Array): Uint8Array {
		const copy = bytes.slice();
		copy.set(bytesOf("an edit in the middle"), bytes.length / 2);
		return copy;
	}

	/** A storage holding what `from` holds, with no upload log of its own. */
	function copyOf(from: FakeStorage): FakeStorage {
		const storage = new FakeStorage();
		for (const [at, blob] of from.map) storage.map.set(at, blob);
		return storage;
	}

	function chunkPuts(storage: FakeStorage): () => number {
		const put = vi.spyOn(storage, "put");
		return () =>
			put.mock.calls.filter(([at]) => at.startsWith("chunks/")).length;
	}

	it("stores a big file as a recipe written after its chunks, and loads it back", async () => {
		const storage = new FakeStorage();
		const bytes = random(SIZE);
		const hash = await sha256Hex(bytes);
		const put = vi.spyOn(storage, "put");

		await storeContent({ storage, key, chunkIds }, hash, bytes);

		expect(storage.map.has(objectKey(hash))).toBe(false);
		expect(put.mock.calls.at(-1)?.[0]).toBe(recipeKey(hash));
		const chunks = (await storage.list("chunks/")).length;
		expect(chunks).toBeGreaterThan(3);
		expect(chunks).toBeLessThan(40);
		expect(await loadContent({ storage, key }, hash, SIZE)).toEqual(bytes);
	});

	it("keeps a file below the threshold whole, and every file whole without a chunk key", async () => {
		const storage = new FakeStorage();
		const small = random(CHUNK_THRESHOLD - 1);
		const big = random(SIZE, 2);
		await storeContent(
			{ storage, key, chunkIds },
			await sha256Hex(small),
			small,
		);
		await storeContent({ storage, key }, await sha256Hex(big), big);
		expect(storage.map.has(objectKey(await sha256Hex(small)))).toBe(true);
		expect(storage.map.has(objectKey(await sha256Hex(big)))).toBe(true);
		expect(await storage.list("chunks/")).toEqual([]);
	});

	it("uploads only the chunks an edit changed, trusting those HEAD's recipe names", async () => {
		const first = new FakeStorage();
		const v1 = random(SIZE);
		const h1 = await sha256Hex(v1);
		await storeContent({ storage: first, key, chunkIds }, h1, v1);
		const all = (await first.list("chunks/")).length;
		const v2 = edited(v1);
		const h2 = await sha256Hex(v2);

		const trusting = copyOf(first);
		const trusted = chunkPuts(trusting);
		const exists = vi.spyOn(trusting, "exists");
		await storeContent({ storage: trusting, key, chunkIds }, h2, v2, {
			hash: h1,
			size: SIZE,
		});
		expect(trusted()).toBeLessThanOrEqual(2);
		expect(exists).not.toHaveBeenCalled();
		expect(await loadContent({ storage: trusting, key }, h2, SIZE)).toEqual(v2);

		// Not HEAD's, not uploaded here: GC may be sweeping it, so it goes up again.
		const unvouched = copyOf(first);
		const again = chunkPuts(unvouched);
		await storeContent({ storage: unvouched, key, chunkIds }, h2, v2);
		expect(again()).toBe(all);
	});

	it("skips a chunk this device uploaded once a probe finds it", async () => {
		const storage = new FakeStorage();
		const v1 = random(SIZE);
		await storeContent({ storage, key, chunkIds }, await sha256Hex(v1), v1);
		const puts = chunkPuts(storage);
		const v2 = edited(v1);
		await storeContent({ storage, key, chunkIds }, await sha256Hex(v2), v2);
		expect(puts()).toBeLessThanOrEqual(2);
	});

	it("chunks a big drawing's decoded scene", async () => {
		const storage = new FakeStorage();
		const next = seeded(3);
		const text = Array.from({ length: 400_000 }, () =>
			String.fromCharCode(97 + Math.floor(next() * 26)),
		).join("");
		const json = JSON.stringify({ type: "excalidraw", elements: [{ text }] });
		const bytes = bytesOf(compressedDrawing(json));
		expect(bytes.length).toBeGreaterThanOrEqual(CHUNK_THRESHOLD);
		const hash = await sha256Hex(bytes);

		await storeContent({ storage, key, chunkIds }, hash, bytes);

		const recipe = storage.map.get(recipeKey(hash));
		if (!recipe) throw new Error("no recipe");
		const { header } = await decryptDescribed(key, recipe);
		expect((header as { codec?: unknown }).codec).toBeDefined();
		expect(await loadContent({ storage, key }, hash)).toEqual(bytes);
	});

	it("stores a big file whole when this device cannot compress", async () => {
		vi.stubGlobal("CompressionStream", undefined);
		const storage = new FakeStorage();
		const bytes = random(SIZE);
		const hash = await sha256Hex(bytes);
		await storeContent({ storage, key, chunkIds }, hash, bytes);
		expect(storage.map.has(objectKey(hash))).toBe(true);
		expect(await storage.list("chunks/")).toEqual([]);
	});
});
