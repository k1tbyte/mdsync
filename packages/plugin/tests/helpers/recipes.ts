import type { FakeStorage } from "@tests/helpers/fake-storage";
import {
	type EncryptionKey,
	encryptCompressible,
	encryptDescribed,
	sha256Hex,
} from "@/core/crypto";
import type { DrawingCodec } from "@/core/drawing";
import { chunkKey, recipeKey } from "@/features/sync/content/keys";

/** Stores each part under `chunks/<id>`. */
export async function putChunks(
	storage: FakeStorage,
	key: EncryptionKey,
	parts: Record<string, Uint8Array>,
): Promise<void> {
	for (const [id, part] of Object.entries(parts)) {
		await storage.put(chunkKey(id), await encryptCompressible(key, part));
	}
}

/** Stores a recipe for `hash` naming `chunks`, without storing them. */
export async function putRecipe(
	storage: FakeStorage,
	key: EncryptionKey,
	hash: string,
	chunks: [id: string, size: number][],
	codec?: DrawingCodec,
): Promise<void> {
	const header = codec ? { codec, chunks } : { chunks };
	await storage.put(
		recipeKey(hash),
		await encryptDescribed(key, header, new Uint8Array(0)),
	);
}

/** Stores `parts` as one chunked file, chunk ids being `<label><index>`; returns the file's hash. */
export async function putChunked(
	storage: FakeStorage,
	key: EncryptionKey,
	parts: Uint8Array[],
	label = "c",
): Promise<string> {
	const ids = parts.map((_, index) => `${label}${index}`);
	await putChunks(
		storage,
		key,
		Object.fromEntries(parts.map((part, index) => [ids[index], part])),
	);
	const hash = await sha256Hex(concat(parts));
	await putRecipe(
		storage,
		key,
		hash,
		parts.map((part, index) => [ids[index] as string, part.length]),
	);
	return hash;
}

export function concat(parts: Uint8Array[]): Uint8Array {
	const bytes = new Uint8Array(
		parts.reduce((sum, part) => sum + part.length, 0),
	);
	let at = 0;
	for (const part of parts) {
		bytes.set(part, at);
		at += part.length;
	}
	return bytes;
}
