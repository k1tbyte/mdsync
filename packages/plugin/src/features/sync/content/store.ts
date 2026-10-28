import { type ChunkParams, chunkEnds, gearTable } from "@/core/chunking";
import { chunkId, encryptCompressible, encryptDescribed } from "@/core/crypto";
import { type DrawingCodec, encodeDrawing } from "@/core/drawing";
import { runWithConcurrency } from "@/core/utils";
import type { ObjectStorage } from "@/features/storage";
import { rememberUpload, uploadedHere } from "../remote/uploads";
import type { ChunkRef } from "./header";
import {
	CHUNK_THRESHOLD,
	chunkKey,
	objectKey,
	readOrder,
	recipeKey,
} from "./keys";
import { type ContentSource, recipeChunks } from "./load";

// Every device cuts with the same seed and sizes, or one file would be cut two ways and share nothing.
const GEAR = gearTable(0x6d64);
const KB = 1024;
const SMALL_CHUNKS: ChunkParams = { min: 16 * KB, avg: 64 * KB, max: 256 * KB };
/** Past it, bigger chunks keep a file's recipe and request count small. */
const LARGE_FILE = 16 * KB * KB;
const LARGE_CHUNKS: ChunkParams = {
	min: 256 * KB,
	avg: 1024 * KB,
	max: 4096 * KB,
};
const CHUNK_WRITES = 4;

interface Stored {
	bytes: Uint8Array;
	codec?: DrawingCodec;
}

/**
 * PUTs `bytes` as the file named `hash`: whole, or from {@link CHUNK_THRESHOLD} as a recipe plus the chunks
 * the storage may lack. Whether it holds the root already is the caller's call. `previous`: HEAD's entry at
 * the path, whose chunks HEAD vouches for. False when the root leans on them: it stands only under that HEAD,
 * so a resumed push must store it again rather than trust it.
 */
export async function storeContent(
	source: ContentSource,
	hash: string,
	bytes: Uint8Array,
	previous?: { hash: string; size: number } | null,
): Promise<boolean> {
	const drawing = encodeDrawing(bytes);
	const stored: Stored = drawing
		? { bytes: drawing.stored, codec: drawing.codec }
		: { bytes };
	if (source.chunkIds && bytes.length >= CHUNK_THRESHOLD) {
		const chunked = await storeChunked(
			source,
			source.chunkIds,
			hash,
			bytes.length,
			stored,
			previous,
		);
		if (chunked !== null) return !chunked.leans;
	}
	await source.storage.put(objectKey(hash), await seal(source, bytes, stored));
	return true;
}

/** True when a root of `hash` exists, looked for where its size says first. */
export async function isStored(
	storage: ObjectStorage,
	hash: string,
	size?: number,
): Promise<boolean> {
	for (const storageKey of readOrder(hash, size)) {
		if (await storage.exists(storageKey)) return true;
	}
	return false;
}

async function storeChunked(
	source: ContentSource,
	chunkIds: CryptoKey,
	hash: string,
	size: number,
	stored: Stored,
	previous: { hash: string; size: number } | null | undefined,
): Promise<{ leans: boolean } | null> {
	const parts = cut(stored.bytes, size);
	const ids = await Promise.all(parts.map((part) => chunkId(chunkIds, part)));
	const chunks = parts.map(
		(part, index): ChunkRef => [ids[index] as string, part.length],
	);
	let recipe: Uint8Array;
	try {
		recipe = await encryptDescribed(
			source.key,
			stored.codec ? { codec: stored.codec, chunks } : { chunks },
			new Uint8Array(0),
		);
	} catch {
		// No CompressionStream here: a whole blob is one every peer reads.
		return null;
	}
	const vouched = await chunksOf(source, previous);
	const fresh = new Map<string, Uint8Array>();
	parts.forEach((part, index) => {
		const id = ids[index] as string;
		if (!vouched.has(id)) fresh.set(id, part);
	});
	const { storage } = source;
	await runWithConcurrency([...fresh], CHUNK_WRITES, async ([id, part]) => {
		const storageKey = chunkKey(id);
		// Chunk keys share the upload log with file hashes: neither can be the other.
		if (
			uploadedHere(storage, storageKey) &&
			(await storage.exists(storageKey))
		) {
			return;
		}
		await storage.put(storageKey, await encryptCompressible(source.key, part));
		rememberUpload(storage, storageKey);
	});
	// Last: a recipe present means its chunks landed, so a resumed push may skip the file.
	await storage.put(recipeKey(hash), recipe);
	return { leans: ids.some((id) => vouched.has(id)) };
}

/** Chunk ids `previous`'s recipe names; none when it was stored whole or does not read. */
async function chunksOf(
	source: ContentSource,
	previous: { hash: string; size: number } | null | undefined,
): Promise<Set<string>> {
	if (!previous || previous.size < CHUNK_THRESHOLD) return new Set();
	const blob = await source.storage.get(recipeKey(previous.hash));
	if (!blob) return new Set();
	const named = await recipeChunks(source.key, blob).catch(() => []);
	return new Set(named.map(([id]) => id));
}

function cut(bytes: Uint8Array, size: number): Uint8Array[] {
	const params = size > LARGE_FILE ? LARGE_CHUNKS : SMALL_CHUNKS;
	let start = 0;
	return chunkEnds(bytes, params, GEAR).map((end) => {
		const part = bytes.subarray(start, end);
		start = end;
		return part;
	});
}

async function seal(
	source: ContentSource,
	bytes: Uint8Array,
	stored: Stored,
): Promise<Uint8Array> {
	if (stored.codec) {
		try {
			return await encryptDescribed(
				source.key,
				{ codec: stored.codec },
				stored.bytes,
			);
		} catch {
			// No CompressionStream here: a plain blob is one every peer reads.
		}
	}
	return encryptCompressible(source.key, bytes);
}
