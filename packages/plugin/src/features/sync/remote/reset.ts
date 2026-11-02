import { DEFAULT_CONCURRENCY, REMOTE_MANIFEST_KEY } from "@/core/constants";
import { runWithConcurrency } from "@/core/utils";
import type { StorageAdapter } from "@/features/storage";
import {
	REMOTE_CHUNKS_PREFIX,
	REMOTE_HISTORY_LOG_KEY,
	REMOTE_HISTORY_PREFIX,
	REMOTE_OBJECTS_PREFIX,
	REMOTE_PINS_PREFIX,
	REMOTE_RECIPES_PREFIX,
} from "../constants";
import type { EngineDependencies } from "../engine";

export interface RemoteResetResult {
	deletedKeys: string[];
}

export async function resetRemoteStorage(
	storage: StorageAdapter,
	concurrency = DEFAULT_CONCURRENCY,
	onProgress?: (done: number, total: number) => void,
): Promise<RemoteResetResult> {
	// History must go with its objects: records and pins left behind would name what is gone.
	const [chunkKeys, ...listed] = await Promise.all([
		storage.list(REMOTE_CHUNKS_PREFIX),
		storage.list(REMOTE_OBJECTS_PREFIX),
		storage.list(REMOTE_RECIPES_PREFIX),
		storage.list(REMOTE_PINS_PREFIX),
		storage.list(REMOTE_HISTORY_PREFIX),
	]);
	const rest = Array.from(
		new Set([REMOTE_MANIFEST_KEY, REMOTE_HISTORY_LOG_KEY, ...listed.flat()]),
	);
	const keys = [...rest, ...chunkKeys];
	let done = 0;
	// Chunks last: a root still standing guards its chunks (`stillLands`).
	for (const batch of [rest, chunkKeys]) {
		await runWithConcurrency(batch, concurrency, async (key) => {
			await storage.delete(key);
			onProgress?.(++done, keys.length);
		});
	}
	return { deletedKeys: keys };
}

/** A share keeps everything under its own prefix, so its storage empties whole. */
export async function deleteShareObjects(
	deps: Pick<EngineDependencies, "space" | "storage" | "concurrency">,
): Promise<void> {
	// The vault's storage holds every share's records: never emptied like this.
	if (deps.space.root === "")
		throw new Error("Only a share's storage empties.");
	const keys = await deps.storage.list("");
	await runWithConcurrency(
		keys,
		deps.concurrency ?? DEFAULT_CONCURRENCY,
		(key) => deps.storage.delete(key),
	);
}
