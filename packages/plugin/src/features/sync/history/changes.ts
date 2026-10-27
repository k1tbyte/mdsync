import { entryAt } from "../changes/records";
import type { Manifest, ManifestEntry } from "../types";

import type { SnapshotChanges, SnapshotEntry } from "./types";

function sameEntry(a: ManifestEntry, b: ManifestEntry): boolean {
	return (
		a.hash === b.hash &&
		a.size === b.size &&
		a.mtime === b.mtime &&
		a.kind === b.kind
	);
}

/** Every differing field counts, not just the hash, so replaying backwards reproduces the parent exactly. */
export function diffManifests(
	parent: Manifest | null,
	next: Manifest,
): SnapshotChanges {
	const changes: SnapshotChanges = { added: {}, modified: {}, deleted: {} };
	const parentFiles = parent?.files ?? {};
	for (const [path, entry] of Object.entries(next.files)) {
		const before = entryAt(parentFiles, path);
		if (!before) {
			changes.added[path] = entry;
		} else if (!sameEntry(before, entry)) {
			changes.modified[path] = { from: before, to: entry };
		}
	}
	for (const [path, entry] of Object.entries(parentFiles)) {
		if (!entryAt(next.files, path)) changes.deleted[path] = entry;
	}
	return changes;
}

/** Undoes one snapshot's changes in place, mutating the given file map into its parent's. */
export function undoChanges(
	files: Record<string, ManifestEntry>,
	changes: SnapshotChanges,
): void {
	for (const path of Object.keys(changes.added)) delete files[path];
	for (const [path, change] of Object.entries(changes.modified)) {
		files[path] = change.from;
	}
	for (const [path, entry] of Object.entries(changes.deleted)) {
		files[path] = entry;
	}
}

/** Undoes one snapshot for a single path. `null` means the path did not exist. */
export function undoChangesForPath(
	entry: ManifestEntry | null,
	changes: SnapshotChanges,
	path: string,
): ManifestEntry | null {
	if (entryAt(changes.added, path)) return null;
	const modified = entryAt(changes.modified, path);
	if (modified) return modified.from;
	return entryAt(changes.deleted, path) ?? entry;
}

/** Every version a record names, so all it can restore stays reachable. */
export function changeEntries(changes: SnapshotChanges): ManifestEntry[] {
	return [
		...Object.values(changes.added),
		...Object.values(changes.modified).flatMap(({ from, to }) => [from, to]),
		...Object.values(changes.deleted),
		...Object.values(changes.deletedLast ?? {}),
	];
}

/**
 * One record for a contiguous run, oldest first: the first parent's state to the last record's. A path back
 * where it started drops out, and a file added and deleted inside the run leaves no trace.
 */
export function composeChanges(
	run: readonly SnapshotChanges[],
): SnapshotChanges {
	const merged: SnapshotChanges = { added: {}, modified: {}, deleted: {} };
	const deletedLast: Record<string, ManifestEntry> = {};
	for (const changes of run) {
		for (const path of touchedPaths(changes)) {
			const start = touches(merged, path)
				? startOf(merged, path)
				: startOf(changes, path);
			delete merged.added[path];
			delete merged.modified[path];
			delete merged.deleted[path];
			delete deletedLast[path];
			const end = endOf(changes, path);
			if (end) {
				if (!start) merged.added[path] = end;
				else if (!sameEntry(start, end)) {
					merged.modified[path] = { from: start, to: end };
				}
			} else if (start) {
				merged.deleted[path] = start;
				const last =
					entryAt(changes.deletedLast ?? {}, path) ??
					entryAt(changes.deleted, path);
				if (last && !sameEntry(last, start)) deletedLast[path] = last;
			}
		}
	}
	if (Object.keys(deletedLast).length > 0) merged.deletedLast = deletedLast;
	return merged;
}

function touchedPaths(changes: SnapshotChanges): string[] {
	return [
		...Object.keys(changes.added),
		...Object.keys(changes.modified),
		...Object.keys(changes.deleted),
	];
}

function touches(changes: SnapshotChanges, path: string): boolean {
	return (
		entryAt(changes.added, path) !== undefined ||
		entryAt(changes.modified, path) !== undefined ||
		entryAt(changes.deleted, path) !== undefined
	);
}

/** A touched path before the record; null when it did not exist. */
function startOf(changes: SnapshotChanges, path: string): ManifestEntry | null {
	return undoChangesForPath(null, changes, path);
}

/** A touched path after the record; null when it is gone. */
function endOf(changes: SnapshotChanges, path: string): ManifestEntry | null {
	return (
		entryAt(changes.added, path) ?? entryAt(changes.modified, path)?.to ?? null
	);
}

export function collectChangeHashes(
	changes: SnapshotChanges,
	into: Set<string>,
): void {
	for (const { hash } of changeEntries(changes)) into.add(hash);
}

/**
 * History is best-effort: a dropped update leaves a parent/child mismatch, and walking past it would
 * attribute one snapshot's changes to another.
 */
export function contiguousLength(snapshots: readonly SnapshotEntry[]): number {
	let length = 0;
	for (const [index, entry] of snapshots.entries()) {
		length = index + 1;
		const parent = snapshots[index + 1];
		if (!parent) break;
		if (entry.parentId !== parent.id) break;
	}
	return length;
}
