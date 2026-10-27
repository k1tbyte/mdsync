import { DEFAULT_CONCURRENCY } from "@/core/constants";
import type { EncryptionKey } from "@/core/crypto";
import { runWithConcurrency } from "@/core/utils";
import type { ListedObject, ObjectStorage } from "@/features/storage";
import {
	MANIFEST_VERSION,
	REMOTE_OBJECTS_PREFIX,
	REMOTE_PINS_PREFIX,
} from "../constants";
import { fetchRemoteManifest, objectKey } from "../remote/manifest";
import { SETTLED_AFTER_MS, settledKeys } from "../remote/uploads";
import type { Manifest, ManifestEntry } from "../types";
import { changeEntries } from "./changes";
import { pinKey, readPins } from "./pins";
import { type HistoryRead, readCandidates, readHistory } from "./remote";

export interface SweepOptions {
	concurrency?: number;
	onProgress?: (done: number, total: number) => void;
	/** Sweep only what settled candidate files name: GC's phase 2. */
	freedOnly?: boolean;
}

export interface ReachableSet {
	/** Each reachable hash with its largest known size. */
	hashes: Map<string, number>;
	head: Manifest | null;
	/** Pin keys listed when the set was read. */
	pinned: string;
	/** History keys listed when the set was read. */
	history: ReadonlySet<string>;
	candidates: readonly ListedObject[];
	/** False when a history record or pin could not be read, so the live set is unknown. */
	complete: boolean;
}

/** Every hash HEAD, any listed history record (off the walk too: a superset only keeps more) or any pin names. */
export async function reachableHashes(
	storage: ObjectStorage,
	key: EncryptionKey,
	root: string,
): Promise<ReachableSet> {
	const hashes = new Map<string, number>();
	const reach = (entries: Iterable<ManifestEntry>): void => {
		for (const { hash, size } of entries) {
			hashes.set(hash, Math.max(hashes.get(hash) ?? 0, size));
		}
	};
	const [head, history, pins] = await Promise.all([
		fetchRemoteManifest(storage, key, root),
		readHistory(storage, key, root),
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
	return {
		hashes,
		head,
		pinned: pins.pins
			.map(({ info }) => pinKey(info.id))
			.sort()
			.join(","),
		history: new Set(historyKeys(history)),
		candidates: history.candidates,
		complete: history.unreadable.length === 0 && pins.unreadable.length === 0,
	};
}

/** A candidate file a day old: every listing shows what was written around the run that freed its hashes. */
export function isSettled({ modified }: ListedObject): boolean {
	return modified !== null && modified < Date.now() - SETTLED_AFTER_MS;
}

/**
 * Deletes settled objects nothing reaches (HEAD, a history record, a pin), never one a GC run freed within the
 * last day; needs a backend that can list.
 */
export async function sweepObjects(
	storage: ObjectStorage,
	key: EncryptionKey,
	root: string,
	options: SweepOptions = {},
): Promise<number> {
	const reachable = await reachableHashes(storage, key, root);
	// Without head, objects from an in-progress upload would look like orphans.
	if (!reachable.head) {
		throw new Error(
			"No manifest is published on this remote, so nothing can be identified as an orphan.",
		);
	}
	// Below the fence 1.x clients still sync, and their history names what looks orphaned here.
	if (reachable.head.version < MANIFEST_VERSION) {
		throw new Error(
			"This remote still uses the old file history format. Push once with this version, then try again.",
		);
	}
	// An unreadable record means the live set is unknown, so we cannot safely delete.
	if (!reachable.complete) {
		throw new Error(
			"Some history records could not be read, so orphans cannot be identified safely. Try again later.",
		);
	}

	const objectKeys = await settledKeys(storage, REMOTE_OBJECTS_PREFIX);

	// Another device publishing during the listing makes its new objects look like orphans: bail.
	const headNow = await fetchRemoteManifest(storage, key, root);
	if ((headNow?.snapshotId ?? null) !== reachable.head.snapshotId) {
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

	const due = reachable.candidates.filter(isSettled);
	const held = await readCandidates(
		storage,
		key,
		reachable.candidates.filter((file) => !isSettled(file)),
	);
	if (held.unreadable.length > 0) {
		throw new Error(
			"Some history records could not be read, so orphans cannot be identified safely. Try again later.",
		);
	}
	// An unreadable settled file only leaks its blobs to the next deep clean.
	const freed = options.freedOnly
		? new Set(
				[...(await readCandidates(storage, key, due)).hashes].map(objectKey),
			)
		: null;
	const kept = new Set(
		[...reachable.hashes.keys(), ...held.hashes].map(objectKey),
	);
	const orphans = objectKeys.filter(
		(storageKey) =>
			!kept.has(storageKey) && (freed === null || freed.has(storageKey)),
	);
	let done = 0;
	await runWithConcurrency(
		orphans,
		options.concurrency ?? DEFAULT_CONCURRENCY,
		async (storageKey) => {
			await storage.delete(storageKey);
			options.onProgress?.(++done, orphans.length);
		},
	);
	await runWithConcurrency(due, DEFAULT_CONCURRENCY, (file) =>
		storage.delete(file.key),
	);
	return orphans.length;
}

function historyKeys(read: HistoryRead): string[] {
	return [
		...read.view.pushes.keys(),
		...read.view.objects.keys(),
		...read.unreadable,
	];
}
