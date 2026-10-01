import { DEFAULT_CONCURRENCY } from "@/constants";
import type { StorageAdapter } from "@/storage/types";
import {
	REMOTE_HISTORY_LOG_KEY,
	REMOTE_MANIFEST_KEY,
	REMOTE_OBJECTS_PREFIX,
	REMOTE_PINS_PREFIX,
} from "@/sync/constants";
import type { EngineDependencies } from "@/sync/engine";
import { runWithConcurrency } from "@/utils";

export interface RemoteResetResult {
	deletedKeys: string[];
}

export async function resetRemoteStorage(
	storage: StorageAdapter,
	concurrency = DEFAULT_CONCURRENCY,
	onProgress?: (done: number, total: number) => void,
): Promise<RemoteResetResult> {
	// History must go with its objects; leaving pins behind breaks the log.
	const [objectKeys, pinKeys] = await Promise.all([
		storage.list(REMOTE_OBJECTS_PREFIX),
		storage.list(REMOTE_PINS_PREFIX),
	]);
	const keys = Array.from(
		new Set([
			REMOTE_MANIFEST_KEY,
			REMOTE_HISTORY_LOG_KEY,
			...objectKeys,
			...pinKeys,
		]),
	);
	let done = 0;
	await runWithConcurrency(keys, concurrency, async (key) => {
		await storage.delete(key);
		onProgress?.(++done, keys.length);
	});
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
