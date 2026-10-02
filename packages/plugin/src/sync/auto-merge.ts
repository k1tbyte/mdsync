import { DEFAULT_CONCURRENCY } from "@/constants";
import { ESyncLogOperation } from "@/logs/store";
import { sortedByPath } from "@/shared";
import {
	advanceBaselineForPaths,
	mergeWrittenIntoCache,
} from "@/sync/baseline";
import { HUNK_TEXT_MAX_BYTES, LOG_PATH_LIMIT } from "@/sync/constants";
import { runWithConcurrency } from "@/utils";
import { tryAutoMergeConflict } from "./conflict-merge";
import {
	hasKnownBinaryExtension,
	textToBytes,
	writeLocalFile,
} from "./content";
import type { CompareResult, EngineDependencies } from "./engine";
import { grewFrom, settleLive, writeIncoming } from "./live-notes";
import type { OperationContext, OperationOutcome } from "./operations";
import type { Conflict, Manifest, ManifestEntry, SessionState } from "./types";

export async function autoMergeOp(
	deps: EngineDependencies,
	result: CompareResult,
	ctx: OperationContext,
): Promise<OperationOutcome> {
	const localEntries = new Map<string, ManifestEntry | null>();
	// Indexed by conflict position so order holds whichever download finishes first.
	const merged = new Array<string | null>(result.diff.conflicts.length).fill(
		null,
	);

	await runWithConcurrency(
		result.diff.conflicts,
		deps.concurrency ?? DEFAULT_CONCURRENCY,
		async (conflict, index) => {
			// A share moved or paused meanwhile: what is left would land at its old path.
			if (deps.signal?.aborted) return;
			const entry = await settleConflict(deps, result, conflict);
			if (entry === undefined) return;
			localEntries.set(conflict.path, entry);
			merged[index] = conflict.path;
		},
	);
	const mergedPaths = merged.filter((path): path is string => path !== null);
	const cancelled = deps.signal?.aborted === true;

	if (mergedPaths.length === 0) {
		return { newRemote: result.remote, touchedPaths: new Set(), cancelled };
	}

	const nextHashCache = mergeWrittenIntoCache(
		localEntries,
		result.updatedCache,
	);

	// Advances the baseline so merged content reads as a new local edit, not a conflict.
	const freshState: SessionState = ctx.getFreshState();
	const baseline = nextBaseline(deps, result, freshState.baseline, mergedPaths);
	if (baseline) {
		await ctx.persistState({
			...freshState,
			baseline,
			hashCache: sortedByPath(nextHashCache),
		});
	}

	await ctx.logInfo(
		ESyncLogOperation.Compare,
		`Auto-merged ${mergedPaths.length} conflict(s).`,
		mergedPaths.slice(0, LOG_PATH_LIMIT),
	);
	return {
		newRemote: result.remote,
		touchedPaths: new Set(mergedPaths),
		cancelled,
		// Merged text is new: localEntries ensures the snapshot does not adopt the remote hash and drop the push.
		localEntries,
	};
}

function nextBaseline(
	deps: EngineDependencies,
	result: CompareResult,
	baseline: Manifest | null,
	paths: ReadonlyArray<string>,
): Manifest | null {
	if (!result.remote) return baseline;
	// A device that never synced adopts only what it settled, as a pull would.
	if (!baseline) {
		return advanceBaselineForPaths(
			null,
			result.remote,
			new Set(paths),
			result.snapshot.emptyFolders,
			deps.scope,
		);
	}
	const files = { ...baseline.files };
	for (const path of paths) {
		const remoteEntry = result.remote.files[path];
		// Only an open live note outlives a remote deletion here.
		if (remoteEntry) files[path] = remoteEntry;
		else delete files[path];
	}
	return { ...baseline, files };
}

/** What the file holds once the conflict is settled; undefined leaves it to the user. */
async function settleConflict(
	deps: EngineDependencies,
	result: CompareResult,
	conflict: Conflict,
): Promise<ManifestEntry | null | undefined> {
	const side = await settleLive(deps, result, conflict.path);
	if (side === "later") return undefined;
	if (side === "local") return result.snapshot.files[conflict.path] ?? null;
	const remote = result.remote?.files[conflict.path];
	if (side === "remote" && remote) {
		return (await writeIncoming(deps, conflict.path, remote)) ?? undefined;
	}
	// No common ancestor: nothing to merge against, and no reason to stat.
	if (!conflict.baselineHash) return undefined;
	// Rules out binary/oversized files by path and manifest size without downloading them.
	const mergeable = await isTextMergeCandidate(
		deps,
		conflict.path,
		result.remote,
		deps.state.baseline,
	);
	if (!mergeable) return undefined;
	const text = await tryAutoMergeConflict(deps, conflict);
	if (text === null) return undefined;
	const written = await writeLocalFile(deps, conflict.path, textToBytes(text));
	if (remote) await grewFrom(deps, conflict.path, remote);
	return written;
}

/** Rejects known binary types and oversized files by stat and manifest size, without reading or downloading. */
export async function isTextMergeCandidate(
	deps: Pick<EngineDependencies, "adapter">,
	path: string,
	remote: Manifest | null,
	baseline: Manifest | null,
): Promise<boolean> {
	if (hasKnownBinaryExtension(path)) return false;
	const remoteSize = remote?.files[path]?.size;
	if (remoteSize !== undefined && remoteSize > HUNK_TEXT_MAX_BYTES)
		return false;
	const baselineSize = baseline?.files[path]?.size;
	if (baselineSize !== undefined && baselineSize > HUNK_TEXT_MAX_BYTES)
		return false;
	try {
		const stat = await deps.adapter.stat(path);
		if (stat?.type === "file" && stat.size > HUNK_TEXT_MAX_BYTES) return false;
	} catch {
		// stat failures fall through to the content-based checks
	}
	return true;
}
