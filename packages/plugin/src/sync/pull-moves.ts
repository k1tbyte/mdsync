/**
 * The pull's tree: moves (`sync/moves.ts`) and folders. A file moved remotely is renamed
 * here, never downloaded again, and an edit made here goes with it; a file moved
 * here takes the remote edit of its old path. Each move lands whole or waits.
 */

import { entryAt } from "@/shared/records";
import {
	ensureDir,
	ensureParent,
	removeEmptyDir,
	unchangedSince,
} from "@/vault/io";

import { untouchedSince } from "./content";
import type { CompareResult, EngineDependencies } from "./engine";
import { writeIncoming } from "./live-notes";
import { isUnder } from "./space";
import type { Manifest, ManifestEntry } from "./types";

export interface PulledMoves {
	/** Both paths of every move asked for, landed or waiting: the plain pull leaves them be. */
	paths: Set<string>;
	written: Map<string, ManifestEntry | null>;
}

export async function pullMoves(
	deps: EngineDependencies,
	result: CompareResult,
	requested: ReadonlySet<string>,
): Promise<PulledMoves> {
	const incoming = new Set(result.diff.remoteChanges.map(({ path }) => path));
	const moves = result.diff.moves.filter(
		({ from, to }) =>
			(requested.has(from) || requested.has(to)) &&
			(incoming.has(from) || incoming.has(to)),
	);
	const paths = new Set(moves.flatMap(({ from, to }) => [from, to]));
	const written = new Map<string, ManifestEntry | null>();
	for (const { from, to, side } of moves) {
		// An open room keeps its note; live editing moves it itself.
		if (deps.live?.holds(from) || deps.live?.holds(to)) continue;
		if (side === "remote") {
			if (!(await renameLocal(deps, from, to))) continue;
			written.set(to, entryAt(result.snapshot.files, from) ?? null);
		} else {
			// `to` still holds what `from` had, so their newer text replaces nothing of ours.
			const theirs = entryAt(result.remote?.files ?? {}, from);
			if (!theirs) continue;
			const ours = entryAt(result.snapshot.files, to);
			if (!(await unchangedSince(deps.adapter, to, ours))) continue;
			const ready = untouchedSince(deps, to, ours);
			const local = await writeIncoming(deps, to, theirs, ready);
			if (!local) continue;
			written.set(to, local);
		}
		written.set(from, null);
	}
	return { paths, written };
}

/**
 * Mirrors the remote folder set, so empty directories survive a round trip, and
 * returns the folders it put on disk. Filtered by scope: unfiltered folders
 * would recreate ignored and out-of-scope directories on every pull.
 */
export async function syncFolders(
	deps: EngineDependencies,
	remote: Manifest,
	written: ReadonlyMap<string, ManifestEntry | null>,
): Promise<string[]> {
	const remoteFolders = (remote.folders ?? []).filter((dir) =>
		deps.scope.canDescend(dir),
	);
	const baselineFolders = (deps.state.baseline?.folders ?? []).filter((dir) =>
		deps.scope.canDescend(dir),
	);
	const remoteFolderSet = new Set(remoteFolders);
	const baselineFolderSet = new Set(baselineFolders);
	await removeEmptied(deps, written, remoteFolderSet);
	for (const dir of remoteFolders) {
		// Deleted here since the baseline: the next push deletes it there too.
		if (baselineFolderSet.has(dir) && !(await deps.adapter.exists(dir))) {
			continue;
		}
		await ensureDir(deps.adapter, dir);
	}
	for (const dir of baselineFolders) {
		if (!remoteFolderSet.has(dir)) {
			await removeEmptyDir(deps.adapter, dir);
		}
	}
	return remoteFolders;
}

/**
 * Folders this pull emptied go too: the next push would publish them back as
 * empty folders. Never the space's root, nor one the remote keeps empty.
 */
async function removeEmptied(
	deps: EngineDependencies,
	written: ReadonlyMap<string, ManifestEntry | null>,
	keep: ReadonlySet<string>,
): Promise<void> {
	const { root } = deps.space;
	const dirs = new Set<string>();
	for (const [path, entry] of written) {
		if (entry !== null) continue;
		for (let dir = parentOf(path); dir !== null; dir = parentOf(dir)) {
			if (dir === root || !isUnder(dir, root)) break;
			if (!keep.has(dir) && deps.scope.canDescend(dir)) dirs.add(dir);
		}
	}
	// Deepest first: a parent empties once its children went.
	for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
		await removeEmptyDir(deps.adapter, dir);
	}
}

/** Never over a file that appeared at `to` since the compare, nor from a `from` gone since: the move waits. */
async function renameLocal(
	deps: EngineDependencies,
	from: string,
	to: string,
): Promise<boolean> {
	// A new case of one name is that very file on a case-blind disk.
	const recased = from.toLowerCase() === to.toLowerCase();
	if (!recased && (await deps.adapter.exists(to))) return false;
	if (!(await deps.adapter.exists(from))) return false;
	if (await deps.index?.rename(from, to)) return true;
	await ensureParent(deps.adapter, to);
	await deps.adapter.rename(from, to);
	return true;
}

function parentOf(path: string): string | null {
	const slash = path.lastIndexOf("/");
	return slash > 0 ? path.slice(0, slash) : null;
}
