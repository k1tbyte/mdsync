import {
	bytesOf,
	compressedDrawing,
	plainDrawing,
} from "@tests/helpers/drawing-file";
import { FakeStorage } from "@tests/helpers/fake-storage";
import { beforeAll, describe, expect, it } from "vitest";
import {
	deriveKey,
	type EncryptionKey,
	encryptBytes,
	encryptCompressible,
	encryptDescribed,
	sha256Hex,
} from "@/core/crypto";
import { encodeDrawing } from "@/core/drawing";
import { loadContent } from "@/features/sync/content/load";
import { objectKey } from "@/features/sync/remote/manifest";

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
				/stored in chunks/,
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
