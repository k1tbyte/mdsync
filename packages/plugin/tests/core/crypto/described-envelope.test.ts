import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	decryptBytes,
	decryptDescribed,
	decryptJson,
	deriveKey,
	type EncryptionKey,
	encryptBytes,
	encryptCompressible,
	encryptDescribed,
	isDescribed,
} from "@/core/crypto";
import {
	BLOB_VERSION,
	BLOB_VERSION_DESCRIBED,
	BLOB_VERSION_GZIP,
	GZIP_PAD_BYTES,
} from "@/core/crypto/constants";

let key: EncryptionKey;
beforeAll(async () => {
	key = await deriveKey("pw", new Uint8Array(16));
});
afterEach(() => vi.unstubAllGlobals());

const encoder = new TextEncoder();

describe("described envelope", () => {
	it("round-trips a header and a payload", async () => {
		const header = { codec: { name: "x", width: 3 }, list: [1, "é", null] };
		const payload = encoder.encode("payload ".repeat(500));
		const blob = await encryptDescribed(key, header, payload);

		expect(blob[0]).toBe(BLOB_VERSION_DESCRIBED);
		expect(isDescribed(blob)).toBe(true);
		const opened = await decryptDescribed(key, blob);
		expect(opened.header).toEqual(header);
		expect(opened.payload).toEqual(payload);
	});

	it("round-trips an empty payload and an empty header", async () => {
		const opened = await decryptDescribed(
			key,
			await encryptDescribed(key, {}, new Uint8Array()),
		);
		expect(opened.header).toEqual({});
		expect(opened.payload).toEqual(new Uint8Array());
	});

	it("pads the sealed length to the gzip unit, whatever the payload", async () => {
		const sizes = new Set<number>();
		for (const text of ["a", "bb", "ccc dd"]) {
			const blob = await encryptDescribed(key, {}, encoder.encode(text));
			sizes.add(blob.length);
		}
		expect(sizes.size).toBe(1);
		const [size] = [...sizes];
		// version byte + iv + padded plaintext + GCM tag
		expect((size ?? 0) - 1 - 12 - 16).toBe(GZIP_PAD_BYTES);
	});

	it("is told apart by its first byte only", async () => {
		expect(isDescribed(await encryptBytes(key, encoder.encode("a")))).toBe(
			false,
		);
		expect(
			isDescribed(
				await encryptCompressible(key, encoder.encode("a".repeat(9000))),
			),
		).toBe(false);
		expect(isDescribed(new Uint8Array())).toBe(false);
	});

	it("is refused by decryptBytes and decryptJson: they also open JSON, keys and links", async () => {
		const blob = await encryptDescribed(key, {}, encoder.encode("{}"));
		await expect(decryptBytes(key, blob)).rejects.toThrow(
			`Unsupported blob version: ${BLOB_VERSION_DESCRIBED}`,
		);
		await expect(decryptJson(key, blob)).rejects.toThrow(/Unsupported blob/);
	});

	it("is the only version decryptDescribed opens", async () => {
		for (const blob of [
			await encryptBytes(key, encoder.encode("plain")),
			await encryptCompressible(key, encoder.encode("z".repeat(9000))),
		]) {
			await expect(decryptDescribed(key, blob)).rejects.toThrow(
				/Unsupported blob version/,
			);
		}
	});

	it("fails when the version byte is flipped to another version", async () => {
		const blob = await encryptDescribed(
			key,
			{},
			encoder.encode("x".repeat(100)),
		);
		for (const version of [BLOB_VERSION, BLOB_VERSION_GZIP]) {
			const relabelled = blob.slice();
			relabelled[0] = version;
			await expect(decryptBytes(key, relabelled)).rejects.toThrow();
		}
		const gzip = await encryptCompressible(
			key,
			encoder.encode("y".repeat(9000)),
		);
		expect(gzip[0]).toBe(BLOB_VERSION_GZIP);
		const relabelled = gzip.slice();
		relabelled[0] = BLOB_VERSION_DESCRIBED;
		await expect(decryptDescribed(key, relabelled)).rejects.toThrow();
	});

	it("fails on a wrong key and on a flipped ciphertext byte", async () => {
		const blob = await encryptDescribed(key, { a: 1 }, encoder.encode("p"));
		const other = await deriveKey("other", new Uint8Array(16));
		await expect(decryptDescribed(other, blob)).rejects.toThrow();
		const flipped = blob.slice();
		flipped[flipped.length - 20] = (flipped[flipped.length - 20] ?? 0) ^ 1;
		await expect(decryptDescribed(key, flipped)).rejects.toThrow();
	});

	it("throws where compression is unavailable, so the caller stores plain", async () => {
		vi.stubGlobal("CompressionStream", undefined);
		await expect(
			encryptDescribed(key, {}, encoder.encode("p")),
		).rejects.toThrow(/cannot compress/);
	});

	it("refuses a header length that runs past the plaintext", async () => {
		const sealed = await encryptDescribed(key, { a: 1 }, encoder.encode("p"));
		// Rebuild a blob whose declared header length is larger than what follows.
		const plain = new Uint8Array(8);
		new DataView(plain.buffer).setUint32(0, 1000, true);
		const forged = await sealDescribed(key, plain);
		expect(sealed.length).toBe(forged.length);
		await expect(decryptDescribed(key, forged)).rejects.toThrow(/truncated/);
	});
});

/** A described blob over arbitrary plaintext, built as `encryptDescribed` does. */
async function sealDescribed(
	aesKey: EncryptionKey,
	plaintext: Uint8Array,
): Promise<Uint8Array> {
	const gzipped = new Uint8Array(
		await new Response(
			new Blob([plaintext as BlobPart])
				.stream()
				.pipeThrough(new CompressionStream("gzip")),
		).arrayBuffer(),
	);
	const framed = new Uint8Array(
		Math.ceil((4 + gzipped.length) / GZIP_PAD_BYTES) * GZIP_PAD_BYTES,
	);
	new DataView(framed.buffer).setUint32(0, gzipped.length, true);
	framed.set(gzipped, 4);
	const iv = new Uint8Array(12);
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt(
			{
				name: "AES-GCM",
				iv,
				additionalData: new Uint8Array([BLOB_VERSION_DESCRIBED]),
			},
			aesKey,
			framed,
		),
	);
	const blob = new Uint8Array(1 + iv.length + ciphertext.length);
	blob[0] = BLOB_VERSION_DESCRIBED;
	blob.set(iv, 1);
	blob.set(ciphertext, 1 + iv.length);
	return blob;
}
