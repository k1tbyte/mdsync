import type { EncryptionKey } from "@/core/crypto";
import type { ObjectStorage } from "@/features/storage";
import { loadRemoteBytes } from "../changes/content";
import { entryAt } from "../changes/records";
import { fetchRemoteManifest } from "../remote/manifest";
import type { Manifest, ManifestEntry } from "../types";
import { historyTracks, pickPaths, undoChangesForPath } from "./changes";
import { activityOf } from "./model/activity";
import {
	type Cover,
	coverOf,
	type HistoryView,
	type WalkedRecord,
} from "./model/cover";
import { keptUntil } from "./model/periods";
import {
	deletePin,
	type PinInfo,
	readPinById,
	readPinInfos,
	readPins,
	writePin,
} from "./pins";
import { readHistory } from "./remote";
import { replayTo } from "./replay";
import type {
	Dating,
	DeletedFile,
	DeletedFilesResult,
	FileVersion,
	SnapshotListResult,
	SnapshotSummary,
} from "./types";

export interface HistoryQuery {
	storage: ObjectStorage;
	key: EncryptionKey;
	root: string;
	/** See `HistoryConfig.horizon`. */
	horizon: number | null;
	/** Left out of history (`historyTracks`). */
	configDir?: string;
}

type Source = Pick<HistoryQuery, "storage" | "key" | "root">;

/** Who made a snapshot and when, as a row shows it. */
type Meta = Pick<PinInfo, "id" | "createdAt" | "deviceId" | "deviceName">;

/** HEAD and the walk back from it: the one read every query starts from. */
export async function readTimeline(
	source: Source,
): Promise<{ head: Manifest | null; cover: Cover; view: HistoryView }> {
	const { storage, key, root } = source;
	const [head, history] = await Promise.all([
		fetchRemoteManifest(storage, key, root),
		readHistory(storage, key, root),
	]);
	const cover = coverOf(
		history.view,
		head && {
			id: head.snapshotId,
			parentId: head.parentSnapshotId,
			vaultId: head.vaultId,
		},
	);
	return { head, cover, view: history.view };
}

/**
 * Distinct versions of one path, newest first, each dated by the record that wrote it; pins the walk does not
 * reach follow. A pin marks every version whose content it holds.
 */
export async function getFileHistory(
	query: Source & { path: string },
): Promise<FileVersion[]> {
	const { path } = query;
	const { head, cover } = await readTimeline(query);
	if (!head) return [];
	const pins = await readPins(
		query.storage,
		query.key,
		query.root,
		(pin) => entryAt(pin.manifest.files, path) ?? null,
	);
	const pinOf: PinsByHash = new Map(
		pins.pins.flatMap(({ info, picked }) =>
			picked ? [[picked.hash, info] as const] : [],
		),
	);
	const versions: FileVersion[] = [];
	let entry = entryAt(head.files, path) ?? null;
	// Without HEAD's own record nothing older can be anchored to HEAD's files.
	const chain = cover.lagging ? [] : cover.chain;
	if (chain.length === 0 && entry) {
		versions.push(toVersion(metaOf(head), undated(head), entry, pinOf));
	}
	for (const walked of chain) {
		const before = undoChangesForPath(entry, walked.record.changes, path);
		if (entry && before?.hash !== entry.hash) {
			versions.push({
				...toVersion(walked.record, datingOf(walked), entry, pinOf),
				first: before === null,
				replayable: true,
			});
		}
		entry = before;
	}
	// Written before the walk's end: its snapshot is the oldest record's parent, known only to precede it.
	const oldest = chain[chain.length - 1]?.record;
	if (entry && oldest) {
		const { firstAt } = oldest;
		const meta = { ...oldest, id: oldest.parentId ?? oldest.id };
		versions.push(
			toVersion(
				meta,
				{
					at: firstAt,
					firstAt,
					pushes: 1,
					res: chain[chain.length - 1]?.res ?? null,
				},
				entry,
				pinOf,
			),
		);
	}
	const listed = new Set(versions.map((version) => version.hash));
	for (const { info, picked } of pins.pins) {
		if (!picked || listed.has(picked.hash)) continue;
		listed.add(picked.hash);
		versions.push(toVersion(info, undated(info), picked, pinOf));
	}
	return versions;
}

/**
 * Files gone from HEAD but restorable, newest death first: a path deleted, recreated and deleted again
 * reports its latest. Pins are folded in after.
 */
export async function listDeletedFiles(
	query: HistoryQuery,
): Promise<DeletedFilesResult> {
	const { head, cover } = await readTimeline(query);
	if (!head) return { files: [], lagging: false, truncated: false };
	const found = new Map<string, DeletedFile>();
	// Only a path's newest change can be its latest death: a lagging walk starts below HEAD's own deletions.
	const touched = new Set<string>();
	for (const { record } of cover.chain) {
		const { added, modified, deleted } = record.changes;
		for (const [path, from] of Object.entries(deleted)) {
			if (touched.has(path) || entryAt(head.files, path)) continue;
			found.set(path, {
				path,
				entry: entryAt(record.changes.deletedLast ?? {}, path) ?? from,
				snapshotId: record.id,
				source: "deleted",
				createdAt: record.createdAt,
				deviceId: record.deviceId,
				deviceName: record.deviceName,
				pinned: false,
				keptUntil: keptUntil(record.at, query.horizon),
			});
		}
		for (const changed of [added, modified, deleted]) {
			for (const path of Object.keys(changed)) touched.add(path);
		}
	}
	await applyPins(query, head, found);
	return {
		files: [...found.values()],
		lagging: cover.lagging,
		truncated: cover.truncated,
	};
}

/**
 * A pin proves a file existed, not when it went: its rows say "last seen". It holds only its own hash, so it
 * clears the retention of that version alone.
 */
async function applyPins(
	source: Source,
	head: Manifest,
	found: Map<string, DeletedFile>,
): Promise<void> {
	// Reduced as each pin is read, so the absent files of every pin are never held at once.
	const newest = new Map<
		string,
		{ info: PinInfo; entry: ManifestEntry; order: number }
	>();
	let order = 0;
	await readPins(source.storage, source.key, source.root, (pin, info) => {
		for (const [path, entry] of Object.entries(pin.manifest.files)) {
			order++;
			if (entryAt(head.files, path)) continue;
			// `found` holds only the walk's rows here: a pin's own row is added below.
			const existing = found.get(path);
			if (existing) {
				if (existing.entry.hash === entry.hash) {
					existing.pinned = true;
					existing.keptUntil = null;
				}
				continue;
			}
			// Pins finish in any order: the newest wins, a tie going to the one read first.
			const held = newest.get(path);
			if (held && held.info.createdAt >= info.createdAt) continue;
			newest.set(path, { info, entry, order });
		}
	});
	// Rows as one pass over the pins newest first would add them.
	const rows = [...newest].sort(
		([, a], [, b]) => b.info.createdAt - a.info.createdAt || a.order - b.order,
	);
	for (const [path, { info, entry }] of rows) {
		found.set(path, {
			path,
			entry,
			snapshotId: info.id,
			source: "pinned",
			label: info.label,
			createdAt: info.createdAt,
			deviceId: info.deviceId,
			deviceName: info.deviceName,
			pinned: true,
			keptUntil: null,
		});
	}
}

/** The vault's push timeline, newest first; a pin no longer on the walk follows. */
export async function listSnapshots(
	query: HistoryQuery,
): Promise<SnapshotListResult> {
	const { head, cover, view } = await readTimeline(query);
	if (!head)
		return { snapshots: [], lagging: false, truncated: false, activity: {} };
	const { pins } = await readPinInfos(query.storage, query.key, query.root);
	const pinned = new Map(pins.map((info) => [info.id, info]));
	const summary = (
		meta: Meta,
		dating: Dating,
		files: SnapshotSummary["files"],
		kept: number | null,
	): SnapshotSummary => {
		const pin = pinned.get(meta.id);
		return {
			...dating,
			id: meta.id,
			createdAt: meta.createdAt,
			deviceId: meta.deviceId,
			deviceName: meta.deviceName,
			pinned: pin !== undefined,
			label: pin?.label,
			files,
			keptUntil: pin ? null : kept,
			restorable: !cover.lagging || pin !== undefined,
			isHead: meta.id === head.snapshotId,
		};
	};
	const snapshots = cover.chain.map((walked) =>
		summary(
			walked.record,
			datingOf(walked),
			walked.record.changes,
			keptUntil(walked.record.at, query.horizon),
		),
	);
	const onChain = new Set(snapshots.map((snapshot) => snapshot.id));
	for (const info of pins) {
		if (!onChain.has(info.id))
			snapshots.push(summary(info, undated(info), null, null));
	}
	return {
		snapshots,
		lagging: cover.lagging,
		truncated: cover.truncated,
		activity: activityOf(view, cover, head.vaultId),
	};
}

/** Replay first; a pin's stored manifest covers snapshots the walk no longer reaches. */
export async function resolveSnapshotManifest(
	source: Source,
	snapshotId: string,
): Promise<Manifest | null> {
	const replayed = await replaySnapshot(source, snapshotId);
	if (replayed) return replayed;
	const pin = await readPinById(
		source.storage,
		source.key,
		source.root,
		snapshotId,
	);
	return pin?.manifest ?? null;
}

async function replaySnapshot(
	source: Source,
	snapshotId: string,
): Promise<Manifest | null> {
	const { head, cover } = await readTimeline(source);
	return head ? replayTo(head, cover, snapshotId) : null;
}

/**
 * Pinning stores the snapshot's manifest without the configuration folder; a readable pin keeps its manifest and
 * takes the new label. `label` undefined keeps the pin's name, "" clears it.
 */
export async function setSnapshotPinned(
	source: Source & Pick<HistoryQuery, "configDir">,
	snapshotId: string,
	pinned: boolean,
	label?: string,
): Promise<void> {
	const { storage, key, root } = source;
	if (!pinned) {
		await deletePin(storage, snapshotId);
		return;
	}
	const existing = await readPinById(storage, key, root, snapshotId);
	const replayed = existing ? null : await replaySnapshot(source, snapshotId);
	const manifest =
		existing?.manifest ??
		(replayed && {
			...replayed,
			files: pickPaths(replayed.files, historyTracks(source.configDir)),
		});
	if (!manifest) {
		throw new Error(
			"That snapshot can no longer be rebuilt from history, so it cannot be pinned.",
		);
	}
	await writePin(storage, key, root, {
		id: snapshotId,
		manifest,
		label: label === undefined ? existing?.label : label || undefined,
		pinnedAt: existing?.pinnedAt ?? Date.now(),
	});
}

export async function loadVersionBytes(
	storage: ObjectStorage,
	key: EncryptionKey,
	hash: string,
): Promise<Uint8Array> {
	const plaintext = await loadRemoteBytes({ storage, key }, hash);
	if (!plaintext) {
		throw new Error(`Version content is no longer available (${hash})`);
	}
	return plaintext;
}

function metaOf(manifest: Manifest): Meta {
	return {
		id: manifest.snapshotId,
		createdAt: manifest.createdAt,
		deviceId: manifest.deviceId,
		deviceName: manifest.deviceName,
	};
}

function datingOf({ record, res }: WalkedRecord): Dating {
	const { at, firstAt, pushes } = record;
	return { at, firstAt, pushes, res };
}

/** Off the walk only the device's clock dates it. */
function undated({ createdAt }: Pick<Meta, "createdAt">): Dating {
	return { at: createdAt, firstAt: createdAt, pushes: 1, res: null };
}

type PinsByHash = ReadonlyMap<string, Pick<PinInfo, "id" | "label">>;

function toVersion(
	meta: Meta,
	dating: Dating,
	entry: ManifestEntry,
	pinOf: PinsByHash,
): FileVersion {
	return {
		...dating,
		snapshotId: meta.id,
		hash: entry.hash,
		size: entry.size,
		mtime: entry.mtime,
		kind: entry.kind,
		createdAt: meta.createdAt,
		deviceId: meta.deviceId,
		deviceName: meta.deviceName,
		pinId: pinOf.get(entry.hash)?.id ?? null,
		label: pinOf.get(entry.hash)?.label,
		first: false,
		replayable: false,
	};
}
