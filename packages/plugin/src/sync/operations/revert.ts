import { DEFAULT_CONCURRENCY } from "@/constants";
import { ESyncLogOperation } from "@/logs/store";
import { mergeWrittenIntoCache } from "@/sync/baseline";
import { LOG_PATH_LIMIT } from "@/sync/constants";
import { writeRemoteEntry } from "@/sync/content";
import { withMoves } from "@/sync/moves";
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
	const touched = new Set(withMoves(paths, ours));
	const localEntries = new Map<string, ManifestEntry | null>();
	// Indexed once: a per-path scan is quadratic (76 ms vs 1 ms for 5,000 files).
	const localChanges = new Map(
		result.diff.localChanges.map((change) => [change.path, change]),
	);
	await runWithConcurrency(
		// Deduped: a path listed twice would have two workers writing one cache entry.
		[...touched],
		deps.concurrency ?? DEFAULT_CONCURRENCY,
		async (path) => {
			const change = localChanges.get(path);
			const baselineEntry = deps.state.baseline?.files[path];
			if (!change && !baselineEntry) return;
			if (change?.type === EChangeType.LocalAdd || !baselineEntry) {
				await trashPath(deps.adapter, path);
				localEntries.set(path, null);
				return;
			}
			const entry = await writeRemoteEntry(deps, path, baselineEntry);
			localEntries.set(path, entry);
		},
	);
	const nextHashCache = mergeWrittenIntoCache(
		localEntries,
		result.updatedCache,
	);
	const freshState = ctx.getFreshState();
	await ctx.persistState({ ...freshState, hashCache: nextHashCache });
	await ctx.logInfo(
		ESyncLogOperation.Compare,
		`Reverted ${paths.length} file(s).`,
		Array.from(paths).slice(0, LOG_PATH_LIMIT),
	);
	return { newRemote: result.remote, touchedPaths: touched, localEntries };
};
