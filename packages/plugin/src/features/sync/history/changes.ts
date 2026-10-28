import { entryAt } from "../changes/records";
import type { Manifest, ManifestEntry } from "../types";

import type { SnapshotChanges } from "./types";

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

/** History keeps vault files; the vault's configuration folder only syncs. A share's scope still names it. */
export function untrackedDir(session: {
	space: { root: string };
	scope: { configDir?: string };
}): string | undefined {
	return session.space.root === "" ? session.scope.configDir : undefined;
}

/** No `configDir`: every path. Any casing, as a case-blind disk takes `Config/` for `config/`. */
export function historyTracks(
	configDir: string | undefined,
): (path: string) => boolean {
	const prefix = configDir === undefined ? null : `${configDir}/`.toLowerCase();
	return (path) => prefix === null || !path.toLowerCase().startsWith(prefix);
}

/** The record's side, and every hash the untracked side names: GC frees them when it retires the record. */
export function splitTracked(
	changes: SnapshotChanges,
	tracks: (path: string) => boolean,
): { changes: SnapshotChanges; released: string[] } {
	const side = (kept: boolean): SnapshotChanges => {
		const keep = (path: string) => tracks(path) === kept;
		return {
			added: pickPaths(changes.added, keep),
			modified: pickPaths(changes.modified, keep),
			deleted: pickPaths(changes.deleted, keep),
		};
	};
	const released = changeEntries(side(false)).map(({ hash }) => hash);
	return { changes: side(true), released: [...new Set(released)] };
}

export function pickPaths<T>(
	map: Record<string, T>,
	keep: (path: string) => boolean,
): Record<string, T> {
	return Object.fromEntries(Object.entries(map).filter(([path]) => keep(path)));
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
