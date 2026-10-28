import {
	REMOTE_CHUNKS_PREFIX,
	REMOTE_OBJECTS_PREFIX,
	REMOTE_RECIPES_PREFIX,
} from "../constants";

/** A file this size or more is stored as chunks, judged by the file itself so a manifest entry tells. */
export const CHUNK_THRESHOLD = 256 * 1024;

export function objectKey(hash: string): string {
	return `${REMOTE_OBJECTS_PREFIX}${hash}`;
}

export function recipeKey(hash: string): string {
	return `${REMOTE_RECIPES_PREFIX}${hash}`;
}

export function chunkKey(id: string): string {
	return `${REMOTE_CHUNKS_PREFIX}${id}`;
}

export function isRecipeKey(storageKey: string): boolean {
	return storageKey.startsWith(REMOTE_RECIPES_PREFIX);
}

/** The file hash a `objects/` or `recipes/` key names. */
export function rootHash(storageKey: string): string {
	return storageKey.slice(storageKey.indexOf("/") + 1);
}

/** Every key a file's root may sit under: a hash alone does not say which. */
export function rootKeys(hash: string): [string, string] {
	return [objectKey(hash), recipeKey(hash)];
}

/** Likeliest first: a big file uploaded before chunking sits whole under `objects/`. */
export function readOrder(hash: string, size?: number): string[] {
	const [whole, recipe] = rootKeys(hash);
	if (size === undefined) return [whole, recipe];
	return size >= CHUNK_THRESHOLD ? [recipe, whole] : [whole];
}
