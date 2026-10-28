import { DEFAULT_CONCURRENCY } from "@/core/constants";
import type { EncryptionKey } from "@/core/crypto";
import type { StorageAdapter } from "@/features/storage";
import { runWithFileConcurrency } from "../changes/file-concurrency";
import { REMOTE_CHUNKS_PREFIX } from "../constants";
import { chunkKey, isRecipeKey } from "../content/keys";
import {
	ContentError,
	fetchRoot,
	openContent,
	prepareContent,
	recipeChunks,
} from "../content/load";
import {
	reachableHashes,
	type SweepOptions,
	sweepObjects,
} from "../history/sweep";

export type MaintenanceOptions = Omit<SweepOptions, "only">;

export interface VerifyResult {
	checked: number;
	missing: string[];
	corrupt: string[];
}

export interface CleanResult {
	deletedObjects: number;
}

/** Catches missing objects or silent backend corruption; `deep` also decrypts and hashes. */
export async function verifyRemote(
	storage: StorageAdapter,
	key: EncryptionKey,
	root: string,
	deep: boolean,
	options: MaintenanceOptions = {},
): Promise<VerifyResult> {
	const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
	const reachable = await reachableHashes(storage, key, root);
	if (!reachable.complete) {
		throw new Error(
			"Some history records could not be read, so the check would be incomplete. Try again later.",
		);
	}

	const list = [...reachable.hashes].map(([hash, size]) => ({ hash, size }));
	const missing: string[] = [];
	const corrupt: string[] = [];
	const source = { storage, key };
	let stored: Promise<Set<string>> | undefined;
	// One listing of `chunks/` answers for every recipe, listed only once one is met.
	const chunksMissing = async (blob: Uint8Array): Promise<boolean> => {
		stored ??= storage.list(REMOTE_CHUNKS_PREFIX).then((keys) => new Set(keys));
		const have = await stored;
		return (await recipeChunks(key, blob)).some(
			([id]) => !have.has(chunkKey(id)),
		);
	};
	let done = 0;
	await prepareContent(source, list);
	await runWithFileConcurrency(
		list,
		concurrency,
		(file) => file.size,
		async ({ hash, size }) => {
			const root = await fetchRoot(storage, hash, size);
			try {
				if (!root) missing.push(hash);
				else if (
					isRecipeKey(root.storageKey) &&
					(await chunksMissing(root.blob))
				) {
					missing.push(hash);
				} else if (deep) {
					await openContent(source, root.blob, hash, root.storageKey);
				}
			} catch (error) {
				// A failed read aborts the check: an outage must not read as corrupt.
				if (!(error instanceof ContentError)) throw error;
				corrupt.push(hash);
			}
			options.onProgress?.(++done, list.length);
		},
	);
	return { checked: list.length, missing, corrupt };
}

/** Removes every settled object nothing reaches. */
export async function deepCleanOrphans(
	storage: StorageAdapter,
	key: EncryptionKey,
	root: string,
	options: MaintenanceOptions = {},
): Promise<CleanResult> {
	return { deletedObjects: await sweepObjects(storage, key, root, options) };
}

/** One sentence for the log and the notice, so both stay in step. */
export function cleanSummary(result: CleanResult): string {
	return `removed ${result.deletedObjects} object(s).`;
}
