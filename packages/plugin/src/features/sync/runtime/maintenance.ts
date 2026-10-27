import { DEFAULT_CONCURRENCY } from "@/core/constants";
import { decryptBytes, type EncryptionKey, sha256Hex } from "@/core/crypto";
import type { StorageAdapter } from "@/features/storage";
import { runWithFileConcurrency } from "../changes/file-concurrency";
import {
	reachableHashes,
	type SweepOptions,
	sweepObjects,
} from "../history/sweep";
import { objectKey } from "../remote/manifest";

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

	const list = [...reachable.hashes.keys()];
	const missing: string[] = [];
	const corrupt: string[] = [];
	let done = 0;
	storage.prepareReads?.(list.map(objectKey));
	await runWithFileConcurrency(
		list,
		concurrency,
		(hash) => reachable.hashes.get(hash) ?? Number.POSITIVE_INFINITY,
		async (hash) => {
			const blob = await storage.get(objectKey(hash));
			if (!blob) {
				missing.push(hash);
			} else if (deep) {
				try {
					const plain = await decryptBytes(key, blob);
					if ((await sha256Hex(plain)) !== hash) corrupt.push(hash);
				} catch {
					corrupt.push(hash);
				}
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
