import { DEFAULT_CONCURRENCY } from "@/core/constants";
import type { EncryptionKey } from "@/core/crypto";
import { reportWarning } from "@/core/shared";
import { runWithConcurrency } from "@/core/utils";
import type { StorageAdapter } from "@/features/storage";
import { REMOTE_OBJECTS_PREFIX } from "../constants";
import { objectKey, publishManifestWithGuard } from "../remote/manifest";
import type { Manifest } from "../types";
import {
	changeEntries,
	diffManifests,
	historyTracks,
	splitTracked,
} from "./changes";
import { pushKey, sealPushRecord } from "./remote";
import type { HistoryConfig } from "./types";

/** A sealed record whose write failed, with what decides whether it may still land. */
interface Unwritten {
	blob: Uint8Array;
	key: EncryptionKey;
	vaultId: string;
	hashes: string[];
}

// A gap in the chain until a later push writes them. Keyed by identity, as a share move or a token refresh
// rebuilds the adapter.
const unwritten = new Map<string, Map<string, Unwritten>>();

// One listing page: past it, listing `objects/` once takes fewer requests than a probe per blob.
const PROBE_LIMIT = 1000;

/**
 * The record lands before the publish, so a won push always has one; a lost push leaves a sibling GC removes.
 * Best-effort: a failed write warns and never fails the push.
 */
export async function publishManifestWithHistory(
	storage: StorageAdapter,
	key: EncryptionKey,
	root: string,
	manifest: Manifest,
	parent: Manifest | null,
	history: HistoryConfig | undefined,
	baseline: Manifest | null = null,
	configDir?: string,
): Promise<void> {
	if (history) {
		const waiting = unwritten.get(storage.identity()) ?? new Map();
		unwritten.set(storage.identity(), waiting);
		const { changes, released } = splitTracked(
			diffManifests(parent, manifest),
			historyTracks(configDir),
		);
		const own: Unwritten = {
			blob: await sealPushRecord(key, root, {
				v: 1,
				vaultId: manifest.vaultId,
				id: manifest.snapshotId,
				parentId: manifest.parentSnapshotId,
				createdAt: manifest.createdAt,
				deviceId: manifest.deviceId,
				deviceName: manifest.deviceName,
				changes,
				...(released.length > 0 && { released }),
			}),
			key,
			vaultId: manifest.vaultId,
			hashes: [...new Set(changeEntries(changes).map(({ hash }) => hash))],
		};
		waiting.set(pushKey(manifest.snapshotId), own);
		await writeWaiting(storage, waiting, own);
	}
	// A failed publish keeps its record waiting: the manifest may have landed, and a sibling costs only GC.
	await publishManifestWithGuard(
		storage,
		key,
		root,
		manifest,
		parent?.snapshotId ?? null,
		baseline,
	);
}

/** Oldest first; stops at the first failure, as the rest would likely fail the same way. */
async function writeWaiting(
	storage: StorageAdapter,
	waiting: Map<string, Unwritten>,
	own: Unwritten,
): Promise<void> {
	for (const [storageKey, record] of waiting) {
		try {
			if (record === own || (await stillLands(storage, record, own))) {
				await storage.put(storageKey, record.blob, "application/octet-stream");
			}
			waiting.delete(storageKey);
		} catch (err) {
			reportWarning(
				"A file history record could not be written; the next push retries it.",
				err,
			);
			return;
		}
	}
}

/** A held-back record lands only in its own vault and while every blob it names survived a sweep or a reset. */
async function stillLands(
	storage: StorageAdapter,
	record: Unwritten,
	own: Unwritten,
): Promise<boolean> {
	if (record.key !== own.key || record.vaultId !== own.vaultId) return false;
	if (record.hashes.length > PROBE_LIMIT) {
		const stored = new Set(await storage.list(REMOTE_OBJECTS_PREFIX));
		return record.hashes.every((hash) => stored.has(objectKey(hash)));
	}
	let missing = false;
	await runWithConcurrency(record.hashes, DEFAULT_CONCURRENCY, async (hash) => {
		if (!(await storage.exists(objectKey(hash)))) missing = true;
	});
	return !missing;
}
