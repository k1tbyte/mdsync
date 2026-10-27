import { DEFAULT_CONCURRENCY } from "@/core/constants";
import { ESyncLogOperation } from "@/core/logs";
import { runWithConcurrency, runWithFileConcurrency } from "@/core/utils";
import { trashPath } from "@/core/vault";
import { renameLocal } from "../apply/pull-moves";
import { withMoves } from "../changes/moves";
import { LOG_PATH_LIMIT } from "../constants";
import { coldSince, writeIncoming } from "../live-notes";
import { mergeWrittenIntoCache } from "../remote/baseline";
import { EChangeType, type ManifestEntry } from "../types";
import type { Operation } from "./types";

const LIVE_HELD =
	"These notes are open for live editing: their room keeps its text, so they were left as they are.";

export const revertPathsOp: Operation<ReadonlyArray<string>> = async (
	deps,
	result,
	paths,
	ctx,
) => {
	// Half a move undone would leave the file at neither path.
	const ours = result.diff.moves.filter(({ side }) => side === "local");
	const expanded = withMoves(paths, ours);
	// An open room owns its note: a revert under it would reach every device as an edit.
	const held = new Set(
		withMoves(
			expanded.filter((path) => deps.live?.holds(path)),
			ours,
		),
	);
	const asked = new Set(expanded.filter((path) => !held.has(path)));
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
		coldSince(deps, path, result.snapshot.files[heldAs.get(path) ?? path]);
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
	await runWithFileConcurrency(
		restores,
		concurrency,
		([, entry]) => entry.size,
		async ([path, entry]) => {
			const to = destinationOf.get(path);
			if (to !== undefined && !heldAs.has(path) && !(await unedited(to)())) {
				return;
			}
			const ready = unedited(path);
			const written = await writeIncoming(deps, path, entry, { ready });
			if (written) localEntries.set(path, written);
		},
	);
	// After the restores: a moved file leaves only once its old path holds it again.
	await runWithConcurrency(trashes, concurrency, async (path) => {
		const from = sourceOf.get(path);
		if (localEntries.has(path)) return;
		if (from !== undefined && !localEntries.has(from)) return;
		if (!(await unedited(path)())) return;
		await trashPath(deps.adapter, path);
		localEntries.set(path, null);
	});
	if (localEntries.size === 0 && held.size > 0) throw new Error(LIVE_HELD);
	const nextHashCache = mergeWrittenIntoCache(
		localEntries,
		result.updatedCache,
	);
	const freshState = ctx.getFreshState();
	await ctx.persistState({ ...freshState, hashCache: nextHashCache });
	await ctx.logInfo(
		ESyncLogOperation.Compare,
		`Reverted ${localEntries.size} file(s).${held.size > 0 ? ` Left ${held.size} to live editing.` : ""}`,
		Array.from(localEntries.keys()).slice(0, LOG_PATH_LIMIT),
	);
	return {
		newRemote: result.remote,
		touchedPaths: new Set(localEntries.keys()),
		localEntries,
	};
};
