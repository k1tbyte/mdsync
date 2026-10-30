import { DEFAULT_CONCURRENCY } from "@/core/constants";
import { decryptBytes, type EncryptionKey } from "@/core/crypto";
import { reportWarning } from "@/core/shared";
import { runWithConcurrency } from "@/core/utils";
import type { StorageAdapter } from "@/features/storage";
import { REMOTE_OBJECTS_PREFIX, REMOTE_RECIPES_PREFIX } from "../constants";
import { rootKeys } from "../content/keys";
import { publishManifestWithGuard } from "../remote/manifest";
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
			vaultId: manifest.vaultId,
			hashes: [...new Set(changeEntries(changes).map(({ hash }) => hash))],
		};
		waiting.set(pushKey(manifest.snapshotId), own);
		await writeWaiting(storage, key, waiting, own);
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
	key: EncryptionKey,
	waiting: Map<string, Unwritten>,
	own: Unwritten,
): Promise<void> {
	for (const [storageKey, record] of waiting) {
		try {
			if (record === own || (await stillLands(storage, record, own, key))) {
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

/**
 * A held-back record lands only under the same data key and vault, and while every blob it names survived a
 * sweep or a reset. Asked of its ciphertext: a re-unlock or a rotation builds a new key object of the same key.
 */
async function stillLands(
	storage: StorageAdapter,
	record: Unwritten,
	own: Unwritten,
	key: EncryptionKey,
): Promise<boolean> {
	if (record.vaultId !== own.vaultId) return false;
	if (
		!(await decryptBytes(key, record.blob).then(
			() => true,
			() => false,
		))
	) {
		return false;
	}
	// A root guards its chunks: a sweep deletes them only after it, a reset after every root.
	if (record.hashes.length > PROBE_LIMIT) {
		const listed = await Promise.all(
			[REMOTE_OBJECTS_PREFIX, REMOTE_RECIPES_PREFIX].map((prefix) =>
				storage.list(prefix),
			),
		);
		const stored = new Set(listed.flat());
		return record.hashes.every((hash) =>
			rootKeys(hash).some((storageKey) => stored.has(storageKey)),
		);
	}
	let missing = false;
	await runWithConcurrency(record.hashes, DEFAULT_CONCURRENCY, async (hash) => {
		for (const storageKey of rootKeys(hash)) {
			if (await storage.exists(storageKey)) return;
		}
		missing = true;
	});
	return !missing;
}
