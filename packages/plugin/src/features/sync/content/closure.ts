import type { EncryptionKey } from "@/core/crypto";
import { runWithConcurrency } from "@/core/utils";
import type { ListedObject, ObjectStorage } from "@/features/storage";
import { chunkKey } from "./keys";
import { recipeChunks } from "./load";

export interface ChunksNamed {
	/** `chunks/` keys. */
	chunks: Set<string>;
	/** Recipes that did not read: what they name is unknown. */
	unreadable: string[];
}

// Chunk keys per recipe and etag: a recipe changes only by a re-put of the same file, so a sweep re-reads
// none it read before.
const memo = new WeakMap<ObjectStorage, Map<string, Read>>();

interface Read {
	etag: string;
	chunks: string[];
}

/** Forgets recipes `listed` (every recipe) no longer holds: a sweep deletes them, a session would keep them. */
export function forgetUnlistedRecipes(
	storage: ObjectStorage,
	listed: readonly ListedObject[],
): void {
	const known = memo.get(storage);
	if (!known) return;
	const keys = new Set(listed.map(({ key }) => key));
	for (const at of known.keys()) if (!keys.has(at)) known.delete(at);
}

/** The chunks `recipes` name; one gone since its listing names nothing. */
export async function chunksNamed(
	storage: ObjectStorage,
	key: EncryptionKey,
	recipes: readonly ListedObject[],
	concurrency: number,
): Promise<ChunksNamed> {
	const known = memo.get(storage) ?? new Map<string, Read>();
	memo.set(storage, known);
	const named: ChunksNamed = { chunks: new Set(), unreadable: [] };
	await runWithConcurrency(recipes, concurrency, async ({ key: at, etag }) => {
		const hit = known.get(at);
		const chunks = hit && hit.etag === etag ? hit.chunks : await read(at);
		if (!chunks) {
			named.unreadable.push(at);
			return;
		}
		if (etag !== null) known.set(at, { etag, chunks });
		for (const chunk of chunks) named.chunks.add(chunk);
	});
	return named;

	async function read(recipeKey: string): Promise<string[] | null> {
		const blob = await storage.get(recipeKey);
		if (!blob) return [];
		try {
			return (await recipeChunks(key, blob)).map(([id]) => chunkKey(id));
		} catch {
			return null;
		}
	}
}
