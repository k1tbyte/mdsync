import { toHex } from "@mdsync/protocol";
import {
	bytesToBase64Url,
	deflateBytes,
	GZIP,
	inflateBytes,
} from "@/core/utils";
import {
	BLOB_VERSION,
	BLOB_VERSION_DESCRIBED,
	BLOB_VERSION_GZIP,
	DESCRIBED_HEADER_BYTES,
	GZIP_LENGTH_BYTES,
	GZIP_PAD_BYTES,
	GZIP_SAMPLE_BYTES,
	GZIP_SAMPLE_MAX_RATIO,
	IV_BYTES,
	JSON_GZIP_MIN_BYTES,
	KDF_ITERATIONS,
	KDF_SALT_LABEL,
	MIN_PASSPHRASE_LENGTH,
} from "./constants";

const subtle = window.crypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type EncryptionKey = CryptoKey;

/** Why a passphrase is too weak to set, or null. */
export function weakPassphrase(passphrase: string): string | null {
	return [...passphrase].length < MIN_PASSPHRASE_LENGTH
		? `A passphrase needs at least ${MIN_PASSPHRASE_LENGTH} characters.`
		: null;
}

export async function deriveKey(
	passphrase: string,
	salt: Uint8Array,
): Promise<EncryptionKey> {
	if (!passphrase) {
		throw new Error("Passphrase is empty");
	}
	const baseKey = await subtle.importKey(
		"raw",
		// One passphrase typed or pasted on two systems may differ in Unicode form.
		encoder.encode(passphrase.normalize("NFC")),
		{ name: "PBKDF2" },
		false,
		["deriveKey"],
	);
	const label = encoder.encode(KDF_SALT_LABEL);
	const saltBytes = new Uint8Array(label.length + salt.length);
	saltBytes.set(label, 0);
	saltBytes.set(salt, label.length);
	return subtle.deriveKey(
		{
			name: "PBKDF2",
			salt: saltBytes,
			iterations: KDF_ITERATIONS,
			hash: "SHA-256",
		},
		baseKey,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

/** Imports raw key bytes as an AES-GCM content key (the envelope data key). */
export async function importAesKey(raw: Uint8Array): Promise<EncryptionKey> {
	return subtle.importKey(
		"raw",
		toBufferSource(raw),
		{ name: "AES-GCM" },
		false,
		["encrypt", "decrypt"],
	);
}

export async function encryptBytes(
	key: EncryptionKey,
	plaintext: Uint8Array,
): Promise<Uint8Array> {
	return sealBytes(key, plaintext, BLOB_VERSION);
}

async function sealBytes(
	key: EncryptionKey,
	plaintext: Uint8Array,
	version: number,
): Promise<Uint8Array> {
	const iv = randomBytes(IV_BYTES);
	const aad = versionAad(version);
	const ciphertext = new Uint8Array(
		await subtle.encrypt(
			{
				name: "AES-GCM",
				iv: toBufferSource(iv),
				...(aad ? { additionalData: toBufferSource(aad) } : {}),
			},
			key,
			toBufferSource(plaintext),
		),
	);
	const out = new Uint8Array(1 + iv.length + ciphertext.length);
	out[0] = version;
	out.set(iv, 1);
	out.set(ciphertext, 1 + iv.length);
	return out;
}

/**
 * The version byte sits outside the ciphertext, so bind it to stop a blob being relabelled compressed. Only
 * the new version: {@link BLOB_VERSION} blobs were sealed without it.
 */
function versionAad(version: number): Uint8Array | undefined {
	return version === BLOB_VERSION ? undefined : new Uint8Array([version]);
}

export async function decryptBytes(
	key: EncryptionKey,
	blob: Uint8Array,
): Promise<Uint8Array> {
	const plaintext = await open(key, blob, [BLOB_VERSION, BLOB_VERSION_GZIP]);
	if (blob[0] !== BLOB_VERSION_GZIP) return plaintext;
	return inflatePadded(plaintext);
}

/** The authenticated plaintext of a blob whose version is one of `versions`. */
async function open(
	key: EncryptionKey,
	blob: Uint8Array,
	versions: readonly number[],
): Promise<Uint8Array> {
	if (blob.length < 1 + IV_BYTES + 16) {
		throw new Error("Encrypted blob is too short");
	}
	const version = blob[0] ?? 0;
	if (!versions.includes(version)) {
		throw new Error(`Unsupported blob version: ${version}`);
	}
	const iv = blob.subarray(1, 1 + IV_BYTES);
	const ciphertext = blob.subarray(1 + IV_BYTES);
	const aad = versionAad(version);
	return new Uint8Array(
		await subtle.decrypt(
			{
				name: "AES-GCM",
				iv: toBufferSource(iv),
				...(aad ? { additionalData: toBufferSource(aad) } : {}),
			},
			key,
			toBufferSource(ciphertext),
		),
	);
}

async function inflatePadded(padded: Uint8Array): Promise<Uint8Array> {
	if (typeof DecompressionStream !== "function") {
		throw new Error(
			"This remote is compressed and this device cannot decompress it. Update Obsidian, or sync this vault from another device.",
		);
	}
	return inflateBytes(unpad(padded), GZIP);
}

function paddedLength(gzipLength: number): number {
	return (
		Math.ceil((GZIP_LENGTH_BYTES + gzipLength) / GZIP_PAD_BYTES) *
		GZIP_PAD_BYTES
	);
}

function pad(gzipped: Uint8Array): Uint8Array {
	const out = new Uint8Array(paddedLength(gzipped.length));
	new DataView(out.buffer).setUint32(0, gzipped.length, true);
	out.set(gzipped, GZIP_LENGTH_BYTES);
	return out;
}

function unpad(padded: Uint8Array): Uint8Array {
	if (padded.length < GZIP_LENGTH_BYTES) {
		throw new Error("Compressed blob is too short");
	}
	const length = new DataView(
		padded.buffer,
		padded.byteOffset,
		padded.byteLength,
	).getUint32(0, true);
	const end = GZIP_LENGTH_BYTES + length;
	if (end > padded.length) throw new Error("Compressed blob is truncated");
	return padded.subarray(GZIP_LENGTH_BYTES, end);
}

export async function encryptJson(
	key: EncryptionKey,
	value: unknown,
): Promise<Uint8Array> {
	return sealSmallest(
		key,
		encoder.encode(JSON.stringify(value)),
		JSON_GZIP_MIN_BYTES,
	);
}

/** File content: gzipped when that makes the blob smaller. Every release since 1.0.0 reads both. */
export async function encryptCompressible(
	key: EncryptionKey,
	bytes: Uint8Array,
): Promise<Uint8Array> {
	// Below one pad unit the sealed blob cannot shrink.
	return sealSmallest(key, bytes, GZIP_PAD_BYTES);
}

async function sealSmallest(
	key: EncryptionKey,
	plaintext: Uint8Array,
	minBytes: number,
): Promise<Uint8Array> {
	const gzipped = await gzipIfSmaller(plaintext, minBytes);
	if (!gzipped) return encryptBytes(key, plaintext);
	return sealBytes(key, pad(gzipped), BLOB_VERSION_GZIP);
}

/**
 * Null keeps the blob at {@link BLOB_VERSION}, so a device without CompressionStream still writes a
 * remote its peers can read.
 */
async function gzipIfSmaller(
	bytes: Uint8Array,
	minBytes: number,
): Promise<Uint8Array | null> {
	if (bytes.length < minBytes) return null;
	try {
		if (!(await compressible(bytes))) return null;
		const out = await deflateBytes(bytes, GZIP);
		if (!out) return null;
		return paddedLength(out.length) < bytes.length ? out : null;
	} catch {
		return null;
	}
}

/** A sample decides for large inputs, so media and archives are not compressed whole for nothing. */
async function compressible(bytes: Uint8Array): Promise<boolean> {
	if (bytes.length <= GZIP_SAMPLE_BYTES) return true;
	const sample = await deflateBytes(bytes.subarray(0, GZIP_SAMPLE_BYTES), GZIP);
	return (
		sample !== null && sample.length < GZIP_SAMPLE_BYTES * GZIP_SAMPLE_MAX_RATIO
	);
}

export function isDescribed(blob: Uint8Array): boolean {
	return blob[0] === BLOB_VERSION_DESCRIBED;
}

/**
 * File content with a JSON `header` describing how `payload` maps to it. Always gzipped (a build without
 * CompressionStream throws, so the caller stores the plain form), padded like {@link BLOB_VERSION_GZIP}.
 */
export async function encryptDescribed(
	key: EncryptionKey,
	header: object,
	payload: Uint8Array,
): Promise<Uint8Array> {
	const head = encoder.encode(JSON.stringify(header));
	const plaintext = new Uint8Array(
		DESCRIBED_HEADER_BYTES + head.length + payload.length,
	);
	new DataView(plaintext.buffer).setUint32(0, head.length, true);
	plaintext.set(head, DESCRIBED_HEADER_BYTES);
	plaintext.set(payload, DESCRIBED_HEADER_BYTES + head.length);
	const gzipped = await deflateBytes(plaintext, GZIP);
	if (!gzipped) {
		throw new Error(
			"This device cannot compress, so it cannot seal a described blob",
		);
	}
	return sealBytes(key, pad(gzipped), BLOB_VERSION_DESCRIBED);
}

/** The header is unchecked: the caller validates its shape. */
export async function decryptDescribed(
	key: EncryptionKey,
	blob: Uint8Array,
): Promise<{ header: unknown; payload: Uint8Array }> {
	const plaintext = await inflatePadded(
		await open(key, blob, [BLOB_VERSION_DESCRIBED]),
	);
	if (plaintext.length < DESCRIBED_HEADER_BYTES) {
		throw new Error("Described blob is too short");
	}
	const length = new DataView(
		plaintext.buffer,
		plaintext.byteOffset,
		plaintext.byteLength,
	).getUint32(0, true);
	const end = DESCRIBED_HEADER_BYTES + length;
	if (end > plaintext.length) throw new Error("Described blob is truncated");
	return {
		header: JSON.parse(
			decoder.decode(plaintext.subarray(DESCRIBED_HEADER_BYTES, end)),
		),
		payload: plaintext.subarray(end),
	};
}

export async function decryptJson<T>(
	key: EncryptionKey,
	blob: Uint8Array,
): Promise<T> {
	const plaintext = await decryptBytes(key, blob);
	return JSON.parse(decoder.decode(plaintext)) as T;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
	const digest = await subtle.digest("SHA-256", toBufferSource(data));
	return toHex(digest);
}

export function randomBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	window.crypto.getRandomValues(bytes);
	return bytes;
}

/** 32 random bytes as base64url: a shared secret such as the relay's. */
export function randomSecret(): string {
	return bytesToBase64Url(randomBytes(32));
}

export function randomId(): string {
	if (typeof window.crypto.randomUUID === "function") {
		return window.crypto.randomUUID();
	}
	return toHex(randomBytes(16));
}

/**
 * Every array here is plain, but a `Uint8Array` over a `SharedArrayBuffer` is not assignable under the DOM
 * types; the cast lives here.
 */
function toBufferSource(bytes: Uint8Array): BufferSource {
	return bytes as BufferSource;
}
