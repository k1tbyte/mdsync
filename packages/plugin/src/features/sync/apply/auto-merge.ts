import { DEFAULT_CONCURRENCY } from "@/core/constants";
import { ESyncLogOperation } from "@/core/logs";
import { asError } from "@/core/shared";
import { runWithConcurrency } from "@/core/utils";
import {
	hasKnownBinaryExtension,
	textToBytes,
	writeLocalFile,
} from "../changes/content";
import { sortedByPath } from "../changes/records";
import { HUNK_TEXT_MAX_BYTES, LOG_PATH_LIMIT } from "../constants";
import type { CompareResult, EngineDependencies } from "../engine";
import { coldSince, grewFrom, settleLive, writeIncoming } from "../live-notes";
import type { OperationContext, OperationOutcome } from "../operations/types";
import { baseStep } from "../recovery/cut-short";
import {
	advanceBaselineForPaths,
	mergeWrittenIntoCache,
} from "../remote/baseline";
import type { Conflict, Manifest, ManifestEntry, SessionState } from "../types";
import { autoMergerFor, tryAutoMergeConflict } from "./conflict-merge";

export async function autoMergeOp(
	deps: EngineDependencies,
	result: CompareResult,
	ctx: OperationContext,
): Promise<OperationOutcome> {
	const localEntries = new Map<string, ManifestEntry | null>();
	// An error stops it as a cancel does: what merged is saved first, as a pull saves what landed.
	let failed: Error | undefined;
	try {
		await runWithConcurrency(
			result.diff.conflicts,
			deps.concurrency ?? DEFAULT_CONCURRENCY,
			async (conflict) => {
				// A share moved or paused meanwhile: what is left would land at its old path.
				if (deps.signal?.aborted) return;
				const entry = await settleConflict(deps, result, conflict);
				if (entry !== undefined) localEntries.set(conflict.path, entry);
			},
		);
	} catch (err) {
		failed = asError(err);
	}
	// In conflict order, whichever download finished first.
	const mergedPaths = result.diff.conflicts
		.map(({ path }) => path)
		.filter((path) => localEntries.has(path));
	if (mergedPaths.length > 0) {
		const nextHashCache = mergeWrittenIntoCache(
			localEntries,
			result.updatedCache,
		);
		// Advances the baseline so merged content reads as a new local edit, not a conflict.
		const freshState: SessionState = ctx.getFreshState();
		const baseline = nextBaseline(
			deps,
			result,
			freshState.baseline,
			mergedPaths,
		);
		if (baseline) {
			await ctx.persistState({
				...freshState,
				baseline,
				hashCache: sortedByPath(nextHashCache),
			});
			await deps.journal?.acknowledge(deps.space);
		}
	}
	if (failed !== undefined) throw failed;
	const cancelled = deps.signal?.aborted === true;
	if (mergedPaths.length === 0) {
		return { newRemote: result.remote, touchedPaths: new Set(), cancelled };
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
	// Edited since the scan: a write now would drop what was typed meanwhile.
	const ready = coldSince(
		deps,
		conflict.path,
		result.snapshot.files[conflict.path],
	);
	const remote = result.remote?.files[conflict.path];
	// Settled on top of the remote version, as `nextBaseline` has it.
	const base = remote && baseStep(deps, conflict.path, remote);
	if (side === "remote" && remote) {
		const written = await writeIncoming(deps, conflict.path, remote, {
			ready,
			base,
		});
		return written ?? undefined;
	}
	// No common ancestor: nothing to merge against, and no reason to stat.
	if (!conflict.baselineHash) return undefined;
	const merge = autoMergerFor(deps.scope, conflict.path);
	if (!merge) return undefined;
	// Rules out binary/oversized files by path and manifest size without downloading them.
	const mergeable = await isTextMergeCandidate(
		deps,
		conflict.path,
		result.remote,
		deps.state.baseline,
	);
	if (!mergeable) return undefined;
	const text = await tryAutoMergeConflict(deps, conflict, merge);
	if (text === null) return undefined;
	const landed = remote && (() => grewFrom(deps, conflict.path, remote));
	const bytes = textToBytes(text);
	return (
		(await writeLocalFile(deps, conflict.path, bytes, {
			ready,
			landed,
			base,
		})) ?? undefined
	);
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
