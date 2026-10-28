import { DEFAULT_CONCURRENCY } from "@/core/constants";
import type { EncryptionKey } from "@/core/crypto";
import { runWithConcurrency } from "@/core/utils";
import type { ObjectStorage } from "@/features/storage";
import { fetchRemoteManifest } from "../remote/manifest";
import { SETTLED_AFTER_MS } from "../remote/uploads";
import type { Manifest } from "../types";
import { activityOf } from "./model/activity";
import { coverOf, type HistoryView } from "./model/cover";
import { freedHashes, planGc } from "./model/plan";
import type { Activity } from "./model/types";
import {
	type HistoryRead,
	readHistory,
	writeCandidates,
	writeHistoryObject,
} from "./remote";
import { isSettled, sweepObjects } from "./sweep";
import type { HistoryConfig, SnapshotChanges } from "./types";

export interface GcResult {
	/** History objects written. */
	written: number;
	/** Push records and objects deleted. */
	retired: number;
	/** File blobs deleted. */
	swept: number;
	/** Pushes per hour as this run read them; null without a HEAD. */
	activity: Activity | null;
}

/**
 * Phase 1 thins history now; phase 2 sweeps what an earlier run freed, once that is a day old. Needs object
 * ages: without them nothing ever looks old enough to pack or sweep.
 */
export async function collectHistoryGarbage(
	storage: ObjectStorage,
	key: EncryptionKey,
	root: string,
	history: HistoryConfig,
): Promise<GcResult> {
	const head = storage.listDetailed
		? await fetchRemoteManifest(storage, key, root)
		: null;
	if (!head) return { written: 0, retired: 0, swept: 0, activity: null };
	const read = await readHistory(storage, key, root);
	const thinned = await thinHistory(storage, key, root, history, head, read);
	const swept = read.candidates.some(isSettled)
		? await sweepObjects(storage, key, root, { freedOnly: true })
		: 0;
	return { ...thinned, swept };
}

/** Writes and verifies the planned objects, records what they freed, then retires what they replace. */
async function thinHistory(
	storage: ObjectStorage,
	key: EncryptionKey,
	root: string,
	history: HistoryConfig,
	head: Manifest,
	{ view, unreadable, now }: HistoryRead,
): Promise<Omit<GcResult, "swept">> {
	// A gap only this run sees would let a counts group or the horizon take what lies behind it.
	if (unreadable.length > 0) {
		throw new Error(
			`File history cleanup stopped: ${unreadable.length} history object(s) could not be read.`,
		);
	}
	const cover = coverOf(view, {
		id: head.snapshotId,
		parentId: head.parentSnapshotId,
		vaultId: head.vaultId,
	});
	const plan = planGc({
		view,
		cover,
		vaultId: head.vaultId,
		now,
		horizon: history.horizon,
		settledBefore: now - SETTLED_AFTER_MS,
	});
	const retire = new Set(plan.deletes);
	const written = new Set<string>();
	const kept: { changes: SnapshotChanges }[] = [];
	for (const build of plan.builds) {
		const stored = await writeHistoryObject(storage, key, root, build);
		written.add(stored.key);
		kept.push(...stored.object.records);
		for (const named of stored.object.consumed) retire.add(named);
	}
	// Only what this run listed: a key named but gone was retired by an earlier run.
	const gone = [...retire].filter(
		(storageKey) =>
			!written.has(storageKey) &&
			(view.pushes.has(storageKey) || view.objects.has(storageKey)),
	);
	const freed = freedHashes(changesOf(view, gone), kept);
	// Recorded first: a crash after it leaves candidates still named, which the sweep keeps.
	if (freed.size > 0) await writeCandidates(storage, key, [...freed]);
	await runWithConcurrency(gone, DEFAULT_CONCURRENCY, (storageKey) =>
		storage.delete(storageKey),
	);
	return {
		written: written.size,
		retired: gone.length,
		activity: activityOf(view, cover, head.vaultId),
	};
}

function changesOf(
	view: HistoryView,
	keys: readonly string[],
): { changes: SnapshotChanges }[] {
	return keys.flatMap((storageKey): { changes: SnapshotChanges }[] => {
		const push = view.pushes.get(storageKey)?.push;
		return push ? [push] : (view.objects.get(storageKey)?.object.records ?? []);
	});
}
