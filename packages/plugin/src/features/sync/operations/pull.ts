import { ESyncLogOperation } from "@/core/logs";
import { formatBytes, sumBytes } from "@/core/shared";
import { pullPaths } from "../apply/pull";
import { entryAt } from "../changes/records";
import { LOG_PATH_LIMIT } from "../constants";
import { buildSessionState, mergeWrittenIntoCache } from "../remote/baseline";
import type { Operation } from "./types";

export const pullPathsOp: Operation<ReadonlyArray<string>> = async (
	deps,
	result,
	asked,
	ctx,
) => {
	if (!result.remote)
		throw new Error("Cannot pull: remote manifest is missing");
	if (result.diff.conflicts.length > 0) {
		throw new Error("Cannot pull: conflicts must be resolved first");
	}
	const { files } = result.remote;
	// Past this device's limit a download is held whole in memory, the crash the scan's own limit avoids.
	const paths = asked.filter(
		(path) => (entryAt(files, path)?.size ?? 0) <= deps.maxFileBytes,
	);
	const pullSet = new Set(paths);
	// Coalesced like the push: a broadcast per file costs 0.16 ms of main thread at 20k files.
	const pulled = await pullPaths(deps, result, paths, (done, total) => {
		ctx.reportProgressSoon(
			`Pulling ${done}/${total}…`,
			total > 0 ? done / total : 0,
		);
	});
	ctx.setProgress(null);
	const hashCache = mergeWrittenIntoCache(pulled.written, result.updatedCache);
	await ctx.persistState(
		buildSessionState(deps.state, pulled.baseline, hashCache),
	);
	await deps.journal?.acknowledge(deps.space);
	if (pulled.failed !== undefined) throw pulled.failed;
	// What happened, not what was asked: a move that waits or a file edited meanwhile did not land.
	const landed = [...pullSet].filter((path) => pulled.written.has(path));
	await ctx.logInfo(
		ESyncLogOperation.Pull,
		pulled.cancelled
			? `Pull cancelled after ${landed.length} of ${pullSet.size} file(s).`
			: `Pulled ${landed.length} file(s) (${formatBytes(sumBytes(landed, files))}).${tooLarge(asked.length - paths.length)}`,
		landed.slice(0, LOG_PATH_LIMIT),
	);
	return {
		newRemote: result.remote,
		// Claiming more would advance state for files never downloaded or held back by an open room.
		touchedPaths: new Set(pulled.written.keys()),
		localEntries: pulled.written,
		cancelled: pulled.cancelled,
	};
};

function tooLarge(count: number): string {
	return count > 0
		? ` Left ${count} file(s) over this device's size limit remote.`
		: "";
}
