import {
	decryptBytes,
	decryptDescribed,
	type EncryptionKey,
	isDescribed,
	sha256Hex,
} from "@/core/crypto";
import { decodeDrawing } from "@/core/drawing";
import { runWithConcurrency } from "@/core/utils";
import type { ObjectStorage } from "@/features/storage";
import { chunksOf } from "./cut";
import { type ChunkRef, type ContentHeader, readHeader } from "./header";
import { chunkKey, isRecipeKey, readOrder } from "./keys";

export interface ContentSource {
	storage: ObjectStorage;
	key: EncryptionKey;
	/** Names chunks; absent stores every file whole. */
	chunkIds?: CryptoKey;
}

const CHUNK_READS = 4;

/** The stored form cannot give the file; a failed read never is one, so deep verify tells them apart. */
export class ContentError extends Error {}

// Recipes `prepareContent` read for its hints, each taken once by the load that needs it. A root names its
// file's hash, so one re-put meanwhile can only give the same file.
const prefetched = new WeakMap<ObjectStorage, Map<string, Uint8Array>>();

/** A copy of the file on this disk, an older version, whose unchanged chunks need no download. */
export interface LocalCopy {
	read(): Promise<Uint8Array | null>;
	/** The remote file's bytes: they pick the chunk sizes. */
	size: number;
}

/**
 * The file `hash` names, or null only when no root of it exists; anything else, a missing chunk too, throws.
 * `size`: the file's bytes, which pick where to look first and stretch the transfer deadline.
 */
export async function loadContent(
	source: ContentSource,
	hash: string,
	size?: number,
	local?: () => Promise<Uint8Array | null>,
): Promise<Uint8Array | null> {
	const root = await fetchRoot(source.storage, hash, size);
	const copy = local && size !== undefined ? { read: local, size } : undefined;
	return root && openContent(source, root.blob, hash, root.storageKey, copy);
}

/** The first root of `hash` that exists, looked for in {@link readOrder}. */
export async function fetchRoot(
	storage: ObjectStorage,
	hash: string,
	size?: number,
): Promise<{ storageKey: string; blob: Uint8Array } | null> {
	for (const storageKey of readOrder(hash, size)) {
		const blob =
			take(storage, storageKey) ?? (await storage.get(storageKey, size));
		if (blob) return { storageKey, blob };
	}
	return null;
}

/**
 * The bytes the root at `storageKey` holds for `hash`, checked against it: a rebuilt file that does not hash to
 * its name is refused. For a caller that fetches the root itself and must tell a failed read from a bad blob.
 */
export async function openContent(
	source: ContentSource,
	blob: Uint8Array,
	hash: string,
	storageKey: string,
	local?: LocalCopy,
): Promise<Uint8Array> {
	const { codec, chunks, payload } = await content(() =>
		openRoot(source.key, blob, isRecipeKey(storageKey)),
	);
	const stored = chunks ? await readChunks(source, chunks, local) : payload;
	const bytes = await content(async () =>
		codec ? decodeDrawing(stored, codec) : stored,
	);
	if ((await sha256Hex(bytes)) !== hash) {
		throw new ContentError(`Hash mismatch for remote object ${hash}`);
	}
	return bytes;
}

/** The chunks a `recipes/` root names; throws when it is not one this build reads. */
export function recipeChunks(
	key: EncryptionKey,
	blob: Uint8Array,
): Promise<ChunkRef[]> {
	return content(async () => {
		const { chunks } = await openRoot(key, blob, true);
		return chunks as ChunkRef[];
	});
}

/**
 * Hints the reads a batch will make: every root it may read, then the chunks big ones name. A hint replaces
 * the one before, so the batch is hinted whole; the recipes read for it are kept for its loads.
 */
export async function prepareContent(
	source: ContentSource,
	entries: readonly { hash: string; size: number }[],
): Promise<void> {
	const { storage } = source;
	prefetched.delete(storage);
	if (!storage.prepareReads) return;
	const roots = entries.flatMap(({ hash, size }) => readOrder(hash, size));
	storage.prepareReads(roots);
	const recipes = roots.filter(isRecipeKey);
	if (recipes.length === 0) return;
	const kept = new Map<string, Uint8Array>();
	prefetched.set(storage, kept);
	const chunks = new Set<string>();
	// Best effort: a read that fails here fails again in its own load, which reports it.
	await runWithConcurrency(recipes, CHUNK_READS, async (storageKey) => {
		const blob = await storage.get(storageKey).catch(() => null);
		if (!blob) return;
		kept.set(storageKey, blob);
		const named = await recipeChunks(source.key, blob).catch(() => []);
		for (const [id] of named) chunks.add(chunkKey(id));
	});
	storage.prepareReads([...roots, ...chunks]);
}

async function openRoot(
	key: EncryptionKey,
	blob: Uint8Array,
	recipe: boolean,
): Promise<ContentHeader & { payload: Uint8Array }> {
	if (!isDescribed(blob)) {
		if (recipe) throw new Error("Unreadable recipe");
		return { payload: await decryptBytes(key, blob) };
	}
	const { header, payload } = await decryptDescribed(key, blob);
	const read = readHeader(header, recipe);
	if (read.chunks && payload.length > 0) throw new Error("Unreadable recipe");
	return { ...read, payload };
}

async function readChunks(
	source: ContentSource,
	chunks: readonly ChunkRef[],
	local: LocalCopy | undefined,
): Promise<Uint8Array> {
	// An id is a MAC of the bytes, so a local chunk of the same id is the same chunk; the hash check stays.
	const onDisk =
		local && source.chunkIds
			? await chunksOf(
					source.chunkIds,
					local.read,
					local.size,
					new Set(chunks.map(([id]) => id)),
				)
			: new Map<string, Uint8Array>();
	const parts: Uint8Array[] = new Array(chunks.length);
	await runWithConcurrency(chunks, CHUNK_READS, async ([id, size], index) => {
		const kept = onDisk.get(id);
		if (kept) {
			parts[index] = kept;
			return;
		}
		const blob = await source.storage.get(chunkKey(id), size);
		if (!blob) throw new ContentError(`A chunk of this file is missing: ${id}`);
		const part = await content(() => decryptBytes(source.key, blob));
		if (part.length !== size) {
			throw new ContentError(`Chunk ${id} has the wrong size`);
		}
		parts[index] = part;
	});
	const bytes = new Uint8Array(chunks.reduce((sum, [, size]) => sum + size, 0));
	let at = 0;
	for (const part of parts) {
		bytes.set(part, at);
		at += part.length;
	}
	return bytes;
}

async function content<T>(open: () => Promise<T>): Promise<T> {
	try {
		return await open();
	} catch (error) {
		if (error instanceof ContentError) throw error;
		throw new ContentError(
			error instanceof Error ? error.message : String(error),
		);
	}
}

function take(storage: ObjectStorage, storageKey: string): Uint8Array | null {
	const kept = prefetched.get(storage);
	const blob = kept?.get(storageKey) ?? null;
	kept?.delete(storageKey);
	return blob;
}
