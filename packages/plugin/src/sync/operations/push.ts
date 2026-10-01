import { ESyncLogOperation } from "@/logs/store";
import { formatBytes, sumBytes } from "@/shared";
import { advanceSessionAfterPush } from "@/sync/baseline";
import { LOG_PATH_LIMIT } from "@/sync/constants";
import { pushPaths } from "@/sync/engine";
import { liveMarks } from "@/sync/live-notes";
import { withMoves } from "@/sync/moves";
import type { Operation } from "./types";

export const pushPathsOp: Operation<ReadonlyArray<string>> = async (
	deps,
	result,
	asked,
	ctx,
) => {
	if (result.diff.conflicts.length > 0) {
		throw new Error("Cannot push: conflicts must be resolved first");
	}
	const paths = withMoves(asked, result.diff.moves);
	const requested = new Set(paths);
	const blockedByRemote = result.diff.remoteChanges.some((c) =>
		requested.has(c.path),
	);
	if (blockedByRemote) {
		throw new Error(
			"Cannot push: some of the selected files have remote changes; pull first",
		);
	}
	// Live notes an open room has not settled on wait for the next push, a move whole.
	const live = await liveMarks(deps, result, paths);
	const marked = new Set(live.paths);
	const waiting = new Set(
		withMoves(
			paths.filter((path) => !marked.has(path)),
			result.diff.moves,
		),
	);
	const ready = live.paths.filter((path) => !waiting.has(path));
	const pushSet = new Set(ready);
	if (paths.length > 0 && pushSet.size === 0) {
		return { newRemote: result.remote, touchedPaths: pushSet };
	}
	const bytesUploaded = sumBytes(ready, result.snapshot.files);
	// Coalesced: a broadcast per file is 3.2 s of main-thread jank across a 20k-file push.
	const manifest = await pushPaths(
		deps,
		result,
		ready,
		(done, total) => {
			ctx.reportProgressSoon(`Pushing ${done}/${total}…`);
		},
		live.marks,
	);
	ctx.setProgress(null);
	const state = advanceSessionAfterPush(
		deps.state,
		result,
		manifest,
		deps.scope,
	);
	await ctx.persistState(state);
	await ctx.logInfo(
		ESyncLogOperation.Push,
		`Pushed ${pushSet.size} file(s) (${formatBytes(bytesUploaded)}).`,
		Array.from(pushSet).slice(0, LOG_PATH_LIMIT),
	);
	return { newRemote: manifest, touchedPaths: pushSet };
};
