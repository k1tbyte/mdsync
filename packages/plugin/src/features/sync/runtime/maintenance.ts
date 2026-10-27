import { DEFAULT_CONCURRENCY } from "@/core/constants";
import { decryptBytes, type EncryptionKey, sha256Hex } from "@/core/crypto";
import { runWithConcurrency } from "@/core/utils";
import type { StorageAdapter } from "@/features/storage";
import { runWithFileConcurrency } from "../changes/file-concurrency";
import { REMOTE_OBJECTS_PREFIX, REMOTE_PINS_PREFIX } from "../constants";
import { changeEntries } from "../history/changes";
import { pinKey, readPins } from "../history/pins";
import { type HistoryRead, readHistory } from "../history/remote";
import { readHistoryLog } from "../history/store";
import { fetchRemoteManifest, objectKey } from "../remote/manifest";
import { settledKeys } from "../remote/uploads";
import type { Manifest, ManifestEntry } from "../types";

export interface MaintenanceOptions {
	concurrency?: number;
	onProgress?: (done: number, total: number) => void;
}

export interface VerifyResult {
	checked: number;
	missing: string[];
	corrupt: string[];
}

export interface CleanResult {
	deletedObjects: number;
}

interface ReachableSet {
	/** Each reachable hash with its largest known size. */
	hashes: Map<string, number>;
	head: Manifest | null;
	/** Pin keys listed when the set was read. */
	pinned: string;
	/** History keys listed when the set was read. */
	history: ReadonlySet<string>;
	/** False when a history record or pin could not be read, so the live set is unknown. */
	complete: boolean;
}

/**
 * Every hash HEAD, any listed history record (off the walk too: a superset only keeps more), any pin or the
 * legacy log names: its versions stay until it is imported.
 */
async function reachableHashes(
	storage: StorageAdapter,
	key: EncryptionKey,
	root: string,
): Promise<ReachableSet> {
	const hashes = new Map<string, number>();
	const reach = (entries: Iterable<ManifestEntry>): void => {
		for (const { hash, size } of entries) {
			hashes.set(hash, Math.max(hashes.get(hash) ?? 0, size));
		}
	};
	const [head, history, legacy, pins] = await Promise.all([
		fetchRemoteManifest(storage, key, root),
		readHistory(storage, key, root),
		readHistoryLog(storage, key, root),
		// Reached as each pin is read, so no more than a few manifests are held at once.
		readPins(storage, key, root, (pin) =>
			reach(Object.values(pin.manifest.files)),
		),
	]);
	if (head) reach(Object.values(head.files));
	for (const { push } of history.view.pushes.values()) {
		reach(changeEntries(push.changes));
	}
	for (const { object } of history.view.objects.values()) {
		for (const record of object.records) reach(changeEntries(record.changes));
	}
	for (const changes of Object.values(legacy.changes)) {
		reach(changeEntries(changes));
	}
	return {
		hashes,
		head,
		pinned: pins.pins
			.map(({ info }) => pinKey(info.id))
			.sort()
			.join(","),
		history: new Set(historyKeys(history)),
		complete: history.unreadable.length === 0 && pins.unreadable.length === 0,
	};
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

/** Removes objects nothing reaches: HEAD, a history record, a pin. Needs a backend that can list. */
export async function deepCleanOrphans(
	storage: StorageAdapter,
	key: EncryptionKey,
	root: string,
	options: MaintenanceOptions = {},
): Promise<CleanResult> {
	const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
	const reachable = await reachableHashes(storage, key, root);
	// An unreadable record means the live set is unknown, so we cannot safely delete.
	if (!reachable.complete) {
		throw new Error(
			"Some history records could not be read, so orphans cannot be identified safely. Try again later.",
		);
	}
	// Without head, objects from an in-progress upload would look like orphans.
	if (!reachable.head) {
		throw new Error(
			"No manifest is published on this remote, so nothing can be identified as an orphan.",
		);
	}

	const objectKeys = await settledKeys(storage, REMOTE_OBJECTS_PREFIX);

	// Another device publishing during the listing makes its new objects look like orphans: bail.
	const headNow = await fetchRemoteManifest(storage, key, root);
	if ((headNow?.snapshotId ?? null) !== (reachable.head?.snapshotId ?? null)) {
		throw new Error(
			"Another device pushed while cleaning; nothing was deleted. Try again.",
		);
	}
	// Pinning does not move HEAD, so a pin created during the listing needs its own check.
	const pinnedNow = (await storage.list(REMOTE_PINS_PREFIX)).sort().join(",");
	if (pinnedNow !== reachable.pinned) {
		throw new Error(
			"Another device changed a pinned snapshot while cleaning; nothing was deleted. Try again.",
		);
	}

	// A record retried meanwhile does not move HEAD either, and may name what looks orphaned.
	const historyNow = await readHistory(storage, key, root);
	if (
		historyKeys(historyNow).some((listed) => !reachable.history.has(listed))
	) {
		throw new Error(
			"Another device wrote file history while cleaning; nothing was deleted. Try again.",
		);
	}

	const liveObjectKeys = new Set(
		[...reachable.hashes.keys()].map((hash) => objectKey(hash)),
	);
	const orphans = objectKeys.filter(
		(storageKey) => !liveObjectKeys.has(storageKey),
	);
	let done = 0;
	await runWithConcurrency(orphans, concurrency, async (storageKey) => {
		await storage.delete(storageKey);
		options.onProgress?.(++done, orphans.length);
	});
	return { deletedObjects: orphans.length };
}

function historyKeys(read: HistoryRead): string[] {
	return [
		...read.view.pushes.keys(),
		...read.view.objects.keys(),
		...read.unreadable,
	];
}

/** One sentence for the log and the notice, so both stay in step. */
export function cleanSummary(result: CleanResult): string {
	return `removed ${result.deletedObjects} object(s).`;
}
