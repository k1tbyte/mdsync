import { DEFAULT_CONCURRENCY } from "@/constants";
import { ESyncLogOperation } from "@/logs/store";
import { mergeWrittenIntoCache } from "@/sync/baseline";
import { LOG_PATH_LIMIT } from "@/sync/constants";
import { untouchedSince, writeRemoteEntry } from "@/sync/content";
import { withMoves } from "@/sync/moves";
import { renameLocal } from "@/sync/pull-moves";
import { EChangeType, type ManifestEntry } from "@/sync/types";
import { runWithConcurrency } from "@/utils";
import { trashPath } from "@/vault/io";
import type { Operation } from "./types";

export const revertPathsOp: Operation<ReadonlyArray<string>> = async (
	deps,
	result,
	paths,
	ctx,
) => {
	// Half a move undone would leave the file at neither path.
	const ours = result.diff.moves.filter(({ side }) => side === "local");
	const asked = new Set(withMoves(paths, ours));
	const moves = ours.filter(({ to }) => asked.has(to));
	const sourceOf = new Map(moves.map(({ from, to }) => [to, from]));
	const destinationOf = new Map(moves.map(({ from, to }) => [from, to]));
	/** A recasing renamed back: its old spelling now holds the file the compare saw under the new one. */
	const heldAs = new Map<string, string>();
	const localEntries = new Map<string, ManifestEntry | null>();
	// Indexed once: a per-path scan is quadratic (76 ms vs 1 ms for 5,000 files).
	const localChanges = new Map(
		result.diff.localChanges.map((change) => [change.path, change]),
	);
	const restores: [string, ManifestEntry][] = [];
	const trashes: string[] = [];
	// Deduped: a path listed twice would have two workers writing one cache entry.
	for (const path of asked) {
		const change = localChanges.get(path);
		const baselineEntry = deps.state.baseline?.files[path];
		// A destination held back by a remote edit of its source has no change of its own.
		if (!change && !baselineEntry && !sourceOf.has(path)) continue;
		if (change?.type === EChangeType.LocalAdd || !baselineEntry) {
			trashes.push(path);
		} else {
			restores.push([path, baselineEntry]);
		}
	}
	const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
	// Edited since the compare: reverting would drop that edit too.
	const unedited = (path: string) =>
		untouchedSince(deps, path, result.snapshot.files[heldAs.get(path) ?? path]);
	// One file under two spellings on a case-blind disk: renamed back, then restored like an edit of it.
	const recased = moves.filter(
		({ from, to }) => from.toLowerCase() === to.toLowerCase(),
	);
	await runWithConcurrency(recased, concurrency, async ({ from, to }) => {
		if (!(await unedited(to)()) || !(await renameLocal(deps, to, from))) return;
		heldAs.set(from, to);
		localEntries.set(to, null);
		localEntries.set(from, result.snapshot.files[to] ?? null);
	});
	await runWithConcurrency(restores, concurrency, async ([path, entry]) => {
		const to = destinationOf.get(path);
		if (to !== undefined && !heldAs.has(path) && !(await unedited(to)())) {
			return;
		}
		const written = await writeRemoteEntry(deps, path, entry, unedited(path));
		if (written) localEntries.set(path, written);
	});
	// After the restores: a moved file leaves only once its old path holds it again.
	await runWithConcurrency(trashes, concurrency, async (path) => {
		const from = sourceOf.get(path);
		if (localEntries.has(path)) return;
		if (from !== undefined && !localEntries.has(from)) return;
		if (!(await unedited(path)())) return;
		await trashPath(deps.adapter, path);
		localEntries.set(path, null);
	});
	const nextHashCache = mergeWrittenIntoCache(
		localEntries,
		result.updatedCache,
	);
	const freshState = ctx.getFreshState();
	await ctx.persistState({ ...freshState, hashCache: nextHashCache });
	await ctx.logInfo(
		ESyncLogOperation.Compare,
		`Reverted ${localEntries.size} file(s).`,
		Array.from(localEntries.keys()).slice(0, LOG_PATH_LIMIT),
	);
	return {
		newRemote: result.remote,
		touchedPaths: new Set(localEntries.keys()),
		localEntries,
	};
};
