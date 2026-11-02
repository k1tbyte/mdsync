import { seeded } from "@tests/helpers/seeded";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	decryptBytes,
	decryptJson,
	deriveKey,
	type EncryptionKey,
	encryptBytes,
	encryptCompressible,
	encryptJson,
} from "@/core/crypto/cipher";
import {
	BLOB_VERSION,
	BLOB_VERSION_GZIP,
	GZIP_PAD_BYTES,
	GZIP_SAMPLE_BYTES,
	IV_BYTES,
	JSON_GZIP_MIN_BYTES,
} from "@/core/crypto/constants";

let key: EncryptionKey;
beforeAll(async () => {
	key = await deriveKey("pw", new Uint8Array(16));
});

/** Manifest-shaped: repetitive keys, one high-entropy hash per entry. */
function manifestLike(entries: number): Record<string, unknown> {
	const files: Record<string, unknown> = {};
	for (let i = 0; i < entries; i++) {
		files[`notes/folder-${i % 50}/file-${i}.md`] = {
			hash: `${i}`.padStart(64, "0"),
			size: 1000 + i,
			mtime: 1_750_000_000_000 + i,
			kind: "vault",
		};
	}
	return { version: 1, snapshotId: "snap", files };
}

describe("encrypted JSON envelope", () => {
	it("round-trips a large document through the compressed version", async () => {
		const value = manifestLike(400);
		const blob = await encryptJson(key, value);

		expect(blob[0]).toBe(BLOB_VERSION_GZIP);
		expect(await decryptJson(key, blob)).toEqual(value);
	});

	it("sends fewer bytes than the same document uncompressed", async () => {
		const value = manifestLike(400);
		const json = new TextEncoder().encode(JSON.stringify(value));
		expect(json.length).toBeGreaterThan(JSON_GZIP_MIN_BYTES);

		const compressed = await encryptJson(key, value);
		const plain = await encryptBytes(key, json);
		expect(compressed.length).toBeLessThan(plain.length / 2);
	});

	it("leaves a small document at the version every build can read", async () => {
		const value = { hello: "world" };
		const blob = await encryptJson(key, value);

		expect(blob[0]).toBe(BLOB_VERSION);
		expect(await decryptJson(key, blob)).toEqual(value);
	});

	it("still reads an uncompressed document written by an older build", async () => {
		const value = manifestLike(400);
		const blob = await encryptBytes(
			key,
			new TextEncoder().encode(JSON.stringify(value)),
		);

		expect(blob[0]).toBe(BLOB_VERSION);
		expect(await decryptJson(key, blob)).toEqual(value);
	});

	it("names the version it cannot read instead of failing inside the parse", async () => {
		const blob = await encryptJson(key, manifestLike(400));
		blob[0] = 0x7f;

		await expect(decryptBytes(key, blob)).rejects.toThrow(
			"Unsupported blob version: 127",
		);
	});

	it("refuses a blob relabelled as compressed", async () => {
		// The version byte rides outside the ciphertext; only binding it to the tag stops a relabelled
		// plain payload from being inflated in memory.
		const json = new TextEncoder().encode(JSON.stringify(manifestLike(400)));
		const gzipped = new Uint8Array(
			await new Response(
				new Blob([json]).stream().pipeThrough(new CompressionStream("gzip")),
			).arrayBuffer(),
		);
		const framed = new Uint8Array(
			Math.ceil((4 + gzipped.length) / GZIP_PAD_BYTES) * GZIP_PAD_BYTES,
		);
		new DataView(framed.buffer).setUint32(0, gzipped.length, true);
		framed.set(gzipped, 4);

		const blob = await encryptBytes(key, framed);
		blob[0] = BLOB_VERSION_GZIP;

		await expect(decryptBytes(key, blob)).rejects.toThrow();
	});

	it("refuses a compressed blob relabelled as plain", async () => {
		const blob = await encryptJson(key, manifestLike(400));
		blob[0] = BLOB_VERSION;

		await expect(decryptBytes(key, blob)).rejects.toThrow();
	});

	it("stores compressed documents on a fixed size grid", async () => {
		// Compress-then-encrypt otherwise reports, through the stored length, how
		// well a chosen string compressed against the rest of the document.
		const blob = await encryptJson(key, manifestLike(400));
		const plaintextLength = blob.length - 1 - IV_BYTES - 16;

		expect(plaintextLength % GZIP_PAD_BYTES).toBe(0);
	});

	it("does not move the stored length for a small change", async () => {
		const value = manifestLike(400);
		const first = await encryptJson(key, value);
		const probed = manifestLike(400);
		(probed.files as Record<string, unknown>)["notes/folder-0/probe.md"] = {
			hash: "0".repeat(64),
			size: 1,
			mtime: 1,
			kind: "vault",
		};
		const second = await encryptJson(key, probed);

		expect(second.length).toBe(first.length);
	});

	it("keeps raw sealing uncompressed, however large", async () => {
		// The key file and links seal through it; file content opts in with encryptCompressible.
		const bytes = new Uint8Array(JSON_GZIP_MIN_BYTES * 4);
		const blob = await encryptBytes(key, bytes);

		expect(blob[0]).toBe(BLOB_VERSION);
		expect(await decryptBytes(key, blob)).toEqual(bytes);
	});
});

/** Incompressible, like media or an archive. */
function noise(length: number, seed = 1): Uint8Array {
	const next = seeded(seed);
	return Uint8Array.from({ length }, () => Math.floor(next() * 256));
}

function note(length: number): Uint8Array {
	const line = "- [ ] A task line in a long note, with a [[link]] and #tag\n";
	return new TextEncoder()
		.encode(line.repeat(Math.ceil(length / line.length)))
		.subarray(0, length);
}

describe("compressible file content", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("stores text compressed and reads it back", async () => {
		const bytes = note(200 * 1024);
		const blob = await encryptCompressible(key, bytes);

		expect(blob[0]).toBe(BLOB_VERSION_GZIP);
		expect(blob.length).toBeLessThan(bytes.length / 4);
		expect(await decryptBytes(key, blob)).toEqual(bytes);
	});

	it("leaves a note smaller than one pad unit as it is", async () => {
		const bytes = note(GZIP_PAD_BYTES - 1);
		const blob = await encryptCompressible(key, bytes);

		expect(blob[0]).toBe(BLOB_VERSION);
		expect(await decryptBytes(key, blob)).toEqual(bytes);
	});

	it("leaves incompressible content as it is", async () => {
		const bytes = noise(32 * 1024);
		const blob = await encryptCompressible(key, bytes);

		expect(blob[0]).toBe(BLOB_VERSION);
		expect(await decryptBytes(key, blob)).toEqual(bytes);
	});

	it("judges a large file by its start", async () => {
		// Compressible past the sample, but media and archives look like noise from the first byte.
		const bytes = new Uint8Array(GZIP_SAMPLE_BYTES * 4);
		bytes.set(noise(GZIP_SAMPLE_BYTES));
		const blob = await encryptCompressible(key, bytes);

		expect(blob[0]).toBe(BLOB_VERSION);
		expect(await decryptBytes(key, blob)).toEqual(bytes);
	});

	it("writes a blob every build reads where the platform cannot compress", async () => {
		vi.stubGlobal("CompressionStream", undefined);
		const bytes = note(200 * 1024);
		const blob = await encryptCompressible(key, bytes);

		expect(blob[0]).toBe(BLOB_VERSION);
		expect(await decryptBytes(key, blob)).toEqual(bytes);
	});
});
