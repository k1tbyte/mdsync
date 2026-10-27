import {
	FILE_HISTORY_MAX_SNAPSHOTS,
	FILE_HISTORY_MIN_SNAPSHOTS,
} from "@/core/constants";
import type { EncryptionKey } from "@/core/crypto";
import { reportWarning } from "@/core/shared";
import { runWithConcurrency } from "@/core/utils";
import type { ObjectStorage } from "@/features/storage";
import { REMOTE_OBJECTS_PREFIX } from "../constants";
import { fetchRemoteManifest, objectKey } from "../remote/manifest";
import { keysByAge, SETTLED_AFTER_MS } from "../remote/uploads";
import type { Manifest } from "../types";
import { collectChangeHashes } from "./changes";
import { pinKey, readPinManifest, updateHistoryLog } from "./store";
import type { HistoryLog, SnapshotEntry } from "./types";

/** Deletes are network round trips; a serial sweep of thousands of them crawls. */
const GC_CONCURRENCY = 4;

/** GC fires only when retained snapshots exceed max by this fraction... */
const FILE_HISTORY_GC_EXCESS_RATIO = 0.3;

/** ...or by this absolute count, whichever is larger. Bounds GC frequency. */
const FILE_HISTORY_GC_MIN_EXCESS = 10;

export function clampMaxSnapshots(value: number): number {
	if (!Number.isFinite(value)) return FILE_HISTORY_MIN_SNAPSHOTS;
	return Math.max(
		FILE_HISTORY_MIN_SNAPSHOTS,
		Math.min(FILE_HISTORY_MAX_SNAPSHOTS, Math.floor(value)),
	);
}

/**
 * Amortised: runs only once retained count overshoots the limit by a buffer, so small limits still get
 * meaningful batches.
 */
export function gcExcessBuffer(maxSnapshots: number): number {
	const max = clampMaxSnapshots(maxSnapshots);
	return Math.max(
		Math.ceil(max * FILE_HISTORY_GC_EXCESS_RATIO),
		FILE_HISTORY_GC_MIN_EXCESS,
	);
}

export function shouldRunGc(
	log: HistoryLog,
	maxSnapshots: number,
	now = Date.now(),
): boolean {
	return (
		evictable(log, maxSnapshots, now).length > gcExcessBuffer(maxSnapshots)
	);
}

/**
 * Past the limit and old enough for their blobs to have settled: a younger record's orphans cannot be swept
 * yet, and once it is pruned nothing names them again.
 */
function evictable(
	log: HistoryLog,
	maxSnapshots: number,
	now: number,
): SnapshotEntry[] {
	return log.snapshots
		.filter((entry) => !entry.pinned)
		.slice(clampMaxSnapshots(maxSnapshots))
		.filter((entry) => now - entry.createdAt >= SETTLED_AFTER_MS);
}

export interface GcInput {
	storage: ObjectStorage;
	key: EncryptionKey;
	root: string;
	log: HistoryLog;
	maxSnapshots: number;
	headManifest: Manifest;
}

export interface GcResult {
	log: HistoryLog;
	deletedObjects: number;
	deletedSnapshots: number;
	skippedObjectSweep: boolean;
}

/**
 * Orphans are hashes an evicted record mentions that nothing retained references. An unreadable pinned
 * manifest skips the sweep: a bounded blob leak beats a dangling reference.
 */
export async function collectGarbage(input: GcInput): Promise<GcResult> {
	const { storage, key, root, log } = input;
	const candidates = evictable(log, input.maxSnapshots, Date.now());
	if (candidates.length === 0) return untouched(log);
	const hashes = new Map(
		candidates.map((entry) => [entry.id, recordHashes(log, entry.id)]),
	);
	const hashesOf = (entry: SnapshotEntry): string[] =>
		hashes.get(entry.id) ?? [];

	const liveHashes = new Set<string>();
	collectHashes(input.headManifest, liveHashes);
	let retainedComplete = true;
	for (const entry of log.snapshots) {
		if (hashes.has(entry.id)) continue;
		const changes = log.changes[entry.id];
		// A kept record we cannot read leaves its hashes unaccounted for.
		if (!changes) {
			retainedComplete = false;
			continue;
		}
		collectChangeHashes(changes, liveHashes);
	}
	const pinned = log.snapshots.filter((entry) => entry.pinned);
	retainedComplete =
		(await addPinnedHashes(storage, key, root, pinned, liveHashes)) &&
		retainedComplete;

	// Another device may have re-uploaded an old hash for a push it has not published: only settled blobs go.
	// Listed before the prune: a record naming one still settling stays, or nothing would name that blob again.
	const orphan = (hash: string): boolean => !liveHashes.has(hash);
	const ages =
		retainedComplete && candidates.some((entry) => hashesOf(entry).some(orphan))
			? await keysByAge(storage, REMOTE_OBJECTS_PREFIX)
			: null;
	const settling = ages
		? candidates.filter((entry) =>
				hashesOf(entry).some(
					(hash) => orphan(hash) && ages.settling.has(objectKey(hash)),
				),
			)
		: [];
	for (const entry of settling) {
		for (const hash of hashesOf(entry)) liveHashes.add(hash);
	}
	const evicted = candidates.filter((entry) => !settling.includes(entry));
	if (evicted.length === 0) return untouched(log);

	const evictedHashes = new Set<string>();
	for (const entry of evicted) {
		for (const hash of hashesOf(entry)) evictedHashes.add(hash);
	}

	// Prune before sweeping: a crash in between leaves orphan blobs (deep-clean collects them), not log
	// versions whose content is gone.
	const evictedIds = new Set(evicted.map((entry) => entry.id));
	const nextLog = await updateHistoryLog(
		storage,
		key,
		root,
		(current) => pruneLog(current, evictedIds),
		(current) =>
			current.snapshots.every(
				(entry) => !evictedIds.has(entry.id) || entry.pinned === true,
			),
	);

	// Re-read head late: a device that published while we pruned may reference a blob we were about to sweep.
	const headNow = await readHead(storage, key, root);
	if (headNow.manifest) collectHashes(headNow.manifest, liveHashes);
	// An unreadable or vanished head might have moved; sweeping risks deleting what it references.
	const headUnchanged =
		headNow.read &&
		headNow.manifest !== null &&
		headNow.manifest.snapshotId === input.headManifest.snapshotId;

	// A pinned snapshot's objects must survive but are not in liveHashes: withhold the sweep until the next round.
	const rescued = await pinnedAmong(storage, evictedIds, nextLog);
	const skippedObjectSweep =
		!retainedComplete || !headUnchanged || rescued.size > 0;

	let deletedObjects = 0;
	const orphans = skippedObjectSweep
		? []
		: [...evictedHashes].filter((hash) => !liveHashes.has(hash));
	if (orphans.length > 0) {
		await runWithConcurrency(orphans, GC_CONCURRENCY, async (hash) => {
			if (!ages?.settled.has(objectKey(hash))) return;
			if (await safeDelete(storage, objectKey(hash))) deletedObjects++;
		});
	}

	const stillPresent = nextLog.snapshots.filter((entry) =>
		evictedIds.has(entry.id),
	).length;
	return {
		log: nextLog,
		deletedObjects,
		deletedSnapshots: evicted.length - stillPresent,
		skippedObjectSweep,
	};
}

function untouched(log: HistoryLog): GcResult {
	return {
		log,
		deletedObjects: 0,
		deletedSnapshots: 0,
		skippedObjectSweep: false,
	};
}

function recordHashes(log: HistoryLog, id: string): string[] {
	const changes = log.changes[id];
	const into = new Set<string>();
	if (changes) collectChangeHashes(changes, into);
	return [...into];
}

/**
 * Pin manifests are written before their flag, so storage, not the log, is the reliable signal: a racing flag
 * can be lost to our log rewrite.
 */
async function pinnedAmong(
	storage: ObjectStorage,
	ids: ReadonlySet<string>,
	log: HistoryLog,
): Promise<Set<string>> {
	const flagged = new Set(
		log.snapshots.filter((entry) => entry.pinned).map((entry) => entry.id),
	);
	const found = new Set<string>();
	await runWithConcurrency([...ids], GC_CONCURRENCY, async (id) => {
		if (flagged.has(id) || (await storage.exists(pinKey(id)))) found.add(id);
	});
	return found;
}

/** Drops evicted snapshots, except any a concurrent device has pinned meanwhile. */
function pruneLog(
	log: HistoryLog,
	evictedIds: ReadonlySet<string>,
): HistoryLog {
	const snapshots = log.snapshots.filter(
		(entry) => !evictedIds.has(entry.id) || entry.pinned === true,
	);
	const keptIds = new Set(snapshots.map((entry) => entry.id));
	const changes: HistoryLog["changes"] = {};
	for (const [id, record] of Object.entries(log.changes)) {
		if (keptIds.has(id)) changes[id] = record;
	}
	return { ...log, snapshots, changes };
}

/** Returns false when a pin's manifest could not be read. */
async function addPinnedHashes(
	storage: ObjectStorage,
	key: EncryptionKey,
	root: string,
	pinned: readonly SnapshotEntry[],
	into: Set<string>,
): Promise<boolean> {
	let complete = true;
	await runWithConcurrency(pinned, GC_CONCURRENCY, async (entry) => {
		const manifest = await readPinManifest(storage, key, root, entry.id);
		if (!manifest) {
			reportWarning(
				`Pinned snapshot "${entry.id}" has no stored manifest, so old file contents cannot be cleaned up. Unpin and pin it again to repair it.`,
			);
			complete = false;
			return;
		}
		collectHashes(manifest, into);
	});
	return complete;
}

function collectHashes(manifest: Manifest, into: Set<string>): void {
	for (const entry of Object.values(manifest.files)) into.add(entry.hash);
}

async function safeDelete(
	storage: ObjectStorage,
	storageKey: string,
): Promise<boolean> {
	try {
		await storage.delete(storageKey);
		return true;
	} catch (err) {
		reportWarning(
			`Could not delete "${storageKey}" during history cleanup.`,
			err,
		);
		return false;
	}
}

/** Separates "no vault published" from a failed fetch. */
async function readHead(
	storage: ObjectStorage,
	key: EncryptionKey,
	root: string,
): Promise<{ read: boolean; manifest: Manifest | null }> {
	try {
		return {
			read: true,
			manifest: await fetchRemoteManifest(storage, key, root),
		};
	} catch (err) {
		reportWarning("Could not re-read the head before collecting garbage.", err);
		return { read: false, manifest: null };
	}
}
