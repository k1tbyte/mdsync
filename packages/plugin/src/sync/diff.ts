import { pairMoves } from "./moves";
import {
	type Conflict,
	type DiffResult,
	EChangeType,
	type FileChange,
	type LocalSnapshot,
	type Manifest,
	type ManifestEntry,
} from "./types";

export interface DiffInput {
	local: LocalSnapshot;
	remote: Manifest | null;
	baseline: Manifest | null;
	/**
	 * Which remote and baseline paths are in scope. Applied here rather than by
	 * copying both manifests first, which at 20k files is two records rebuilt
	 * per compare. The local snapshot is already scoped by the scan, and the
	 * scan's predicate is the stricter of the two, so a local path is always in
	 * scope here too.
	 */
	includes?: (path: string) => boolean;
}

export function diff(input: DiffInput): DiffResult {
	const localFiles = input.local.files;
	// Unreadable is not absent: unreadable files are skipped, not treated as
	// deleted, avoiding accidental pushes.
	const unreadable = new Set(input.local.skipped.map((entry) => entry.path));
	const unreadableDirs = input.local.unreadableDirs;
	const remoteFiles = input.remote?.files ?? {};
	const baselineFiles = input.baseline?.files ?? {};

	const includes = input.includes;
	const paths = new Set<string>();
	for (const p of Object.keys(localFiles)) paths.add(p);
	for (const p of Object.keys(remoteFiles)) {
		if (!includes || includes(p)) paths.add(p);
	}
	for (const p of Object.keys(baselineFiles)) {
		if (!includes || includes(p)) paths.add(p);
	}

	const localChanges: FileChange[] = [];
	const remoteChanges: FileChange[] = [];
	const conflicts: Conflict[] = [];
	const converged: string[] = [];

	for (const path of paths) {
		if (unreadable.has(path) || isUnderUnreadableDir(path, unreadableDirs)) {
			continue;
		}
		const localEntry = localFiles[path];
		const remoteEntry = remoteFiles[path];
		const baselineEntry = baselineFiles[path];
		const local = localEntry?.hash ?? null;
		const remote = remoteEntry?.hash ?? null;
		const baseline = baselineEntry?.hash ?? null;

		const localChanged = !sameContent(localEntry, baselineEntry);
		const remoteChanged = !sameContent(remoteEntry, baselineEntry);

		if (!localChanged && !remoteChanged) continue;

		if (localChanged && remoteChanged) {
			if (sameContent(localEntry, remoteEntry)) {
				converged.push(path);
				continue;
			}
			conflicts.push({
				path,
				localHash: local ?? "",
				remoteHash: remote ?? "",
				baselineHash: baseline,
			});
			continue;
		}

		if (localChanged) {
			localChanges.push({
				path,
				type: classify(baseline, local),
				localHash: local,
				remoteHash: remote,
			});
		} else {
			remoteChanges.push({
				path,
				type: classify(baseline, remote, true),
				localHash: local,
				remoteHash: remote,
			});
		}
	}

	const remoteMoved =
		(input.baseline?.snapshotId ?? null) !== (input.remote?.snapshotId ?? null);

	return pairMoves(
		{ localChanges, remoteChanges, conflicts, converged, remoteMoved },
		baselineFiles,
	);
}

/** A drawing is its scene: saves of one scene differ only in the view state they carry. */
function sameContent(
	a: ManifestEntry | undefined,
	b: ManifestEntry | undefined,
): boolean {
	if (!a || !b) return a === b;
	return a.hash === b.hash || (a.scene !== undefined && a.scene === b.scene);
}

function classify(
	baseline: string | null,
	current: string | null,
	remote = false,
): EChangeType {
	if (baseline === null)
		return remote ? EChangeType.RemoteAdd : EChangeType.LocalAdd;
	if (current === null)
		return remote ? EChangeType.RemoteDelete : EChangeType.LocalDelete;
	return remote ? EChangeType.RemoteModify : EChangeType.LocalModify;
}

/** Empty entry means vault root: nothing is known. */
function isUnderUnreadableDir(
	path: string,
	dirs: ReadonlyArray<string>,
): boolean {
	for (const dir of dirs) {
		if (dir === "" || path.startsWith(`${dir}/`)) return true;
	}
	return false;
}
