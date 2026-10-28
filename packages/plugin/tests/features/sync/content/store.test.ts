import {
	bytesOf,
	compressedDrawing,
	plainDrawing,
} from "@tests/helpers/drawing-file";
import { FakeStorage } from "@tests/helpers/fake-storage";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	decryptDescribed,
	deriveKey,
	type EncryptionKey,
	encryptCompressible,
	sha256Hex,
} from "@/core/crypto";
import { loadContent } from "@/features/sync/content/load";
import { storeContent } from "@/features/sync/content/store";
import { objectKey } from "@/features/sync/remote/manifest";

let key: EncryptionKey;
beforeAll(async () => {
	key = await deriveKey("pw", new Uint8Array(16));
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
