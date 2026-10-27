import { DEFAULT_CONCURRENCY } from "@/core/constants";
import { sceneOfBytes } from "@/core/drawing";
import { ESyncLogOperation } from "@/core/logs";
import { trashPath, unchangedSince } from "@/core/vault";
import { freeConflictCopyPath } from "../apply/conflict-copy";
import {
	loadLocalBytes,
	loadRemoteBytes,
	textToBytes,
	withLocalMtime,
	writeLocalFile,
} from "../changes/content";
import { runWithFileConcurrency } from "../changes/file-concurrency";
import { entryAt } from "../changes/records";
import { LOG_PATH_LIMIT } from "../constants";
import {
	type CompareResult,
	type EngineDependencies,
	knownRemoteHashes,
	publishFileMap,
	storeObject,
} from "../engine";
import { coldSince, settleLive, writeIncoming } from "../live-notes";
import { baseStep } from "../recovery/cut-short";
import {
	advanceBaselineForPaths,
	buildSessionState,
	mergeWrittenIntoCache,
} from "../remote/baseline";
import type { ManifestEntry } from "../types";
import type { Operation, OperationContext, OperationOutcome } from "./types";

const EDITED_SINCE =
	"These files changed since the compare, so accepting the remote version would overwrite that change. Review them again.";

const LIVE_HELD =
	"These notes are open for live editing and their room is not ready to take the remote version yet. Try again in a moment.";

export const batchAcceptRemoteOp: Operation<ReadonlySet<string>> = async (
	deps,
	result,
	paths,
	ctx,
): Promise<OperationOutcome> => {
	const remote = result.remote;
	if (!remote) throw new Error("Cannot resolve: remote manifest is missing");
	const unchanged = new Set<string>();
	for (const path of paths) {
		const scanned = entryAt(result.snapshot.files, path);
		if (await unchangedSince(deps.adapter, path, scanned)) unchanged.add(path);
	}
	if (unchanged.size === 0) throw new Error(EDITED_SINCE);
	const held: string[] = [];
	const { conflictPaths, localEntries } = await resolveEach(
		deps,
		result,
		unchanged,
		ctx,
		async (path) => {
			// An open room takes the remote version in itself: the resolution keeps what it holds.
			const side = await settleLive(deps, result, path);
			if (side === "later") {
				held.push(path);
				return undefined;
			}
			if (side === "local") return entryAt(result.snapshot.files, path) ?? null;
			// Edited while an earlier file downloaded: that edit stays, and so does the conflict.
			const ready = coldSince(deps, path, entryAt(result.snapshot.files, path));
			const remoteEntry = remote.files[path];
			if (remoteEntry) {
				const base = baseStep(deps, path, remoteEntry);
				const written = await writeIncoming(deps, path, remoteEntry, {
					ready,
					base,
				});
				return written ?? undefined;
			}
			// Edit vs delete, accepting remote: the remote side is the deletion.
			if (!(await ready())) return undefined;
			await trashPath(deps.adapter, path);
			return null;
		},
	);
	if (conflictPaths.length === 0) {
		throw new Error(held.length > 0 ? LIVE_HELD : EDITED_SINCE);
	}
	const baseline = advanceBaselineForPaths(
		deps.state.baseline,
		remote,
		new Set(conflictPaths),
		result.snapshot.emptyFolders,
		deps.scope,
	);
	await ctx.persistState(
		buildSessionState(
			deps.state,
			baseline,
			mergeWrittenIntoCache(localEntries, result.updatedCache),
		),
	);
	await deps.journal?.acknowledge(deps.space);
	await ctx.logInfo(
		ESyncLogOperation.Pull,
		`Resolved ${conflictPaths.length} conflict(s) by accepting remote.${held.length > 0 ? ` Left ${held.length} to live editing.` : ""}`,
		conflictPaths.slice(0, LOG_PATH_LIMIT),
	);
	ctx.setProgress(null);
	return {
		newRemote: remote,
		touchedPaths: new Set(conflictPaths),
		localEntries,
	};
};

export const batchKeepLocalOp: Operation<ReadonlySet<string>> = async (
	deps,
	result,
	paths,
	ctx,
): Promise<OperationOutcome> => {
	const files = { ...(result.remote?.files ?? {}) };
	const known = knownRemoteHashes(result);
	const { conflictPaths, localEntries } = await resolveEach(
		deps,
		result,
		paths,
		ctx,
		async (path) => {
			const bytes = await loadLocalBytes(deps.adapter, path);
			if (!bytes) {
				// Delete vs edit, keeping local: the local side is the deletion, so
				// publish it instead of failing on the missing file.
				delete files[path];
				return null;
			}
			const entry = await withLocalMtime(deps.adapter, path, {
				hash: await storeObject(deps, known, bytes),
				size: bytes.length,
				kind: deps.scope.classify(path),
				scene: await sceneOfBytes(path, bytes),
			});
			files[path] = entry;
			return entry;
		},
	);
	const manifest = await publishFileMap(deps, result, files);
	const baseline = advanceBaselineForPaths(
		deps.state.baseline,
		manifest,
		new Set(conflictPaths),
		result.snapshot.emptyFolders,
		deps.scope,
	);
	await ctx.persistState(
		buildSessionState(
			deps.state,
			baseline,
			mergeWrittenIntoCache(localEntries, result.updatedCache),
		),
	);
	await ctx.logInfo(
		ESyncLogOperation.Push,
		`Resolved ${conflictPaths.length} conflict(s) by keeping local.`,
		conflictPaths.slice(0, LOG_PATH_LIMIT),
	);
	ctx.setProgress(null);
	return {
		newRemote: manifest,
		touchedPaths: new Set(conflictPaths),
		localEntries,
	};
};

/**
 * The copy lands before the resolution publishes, so a failed push cannot lose it; as a new local file it
 * publishes with the next push.
 */
export const keepBothConflictOp: Operation<string> = async (
	deps,
	result,
	path,
	ctx,
): Promise<OperationOutcome> => {
	const conflict = result.diff.conflicts.find((c) => c.path === path);
	if (!conflict) throw new Error(`No conflict on "${path}"`);
	if (conflict.remoteHash === "") {
		throw new Error(
			`"${path}" was deleted remotely: there is no version to keep beside it.`,
		);
	}
	const bytes = await loadRemoteBytes(
		{ storage: deps.storage, key: deps.key },
		conflict.remoteHash,
	);
	if (!bytes) {
		throw new Error(
			`Cannot keep the remote version of "${path}": its object is missing`,
		);
	}
	const copyPath = await freeConflictCopyPath(
		deps.adapter,
		path,
		result.remote?.deviceName,
	);
	await writeLocalFile(deps, copyPath, bytes);
	await ctx.logInfo(
		ESyncLogOperation.Push,
		`Kept the local version of "${path}"; the remote one is saved as "${copyPath}" and publishes with the next push.`,
	);
	return batchKeepLocalOp(deps, result, new Set([path]), ctx);
};

export interface MergedSaveArgs {
	path: string;
	content: string;
	expected: { localHash: string; remoteHash: string };
}

export const saveMergedOp: Operation<MergedSaveArgs> = async (
	deps,
	result,
	{ path, content, expected },
	ctx,
) => {
	const conflict = result.diff.conflicts.find((c) => c.path === path);
	if (
		conflict?.localHash !== expected.localHash ||
		conflict.remoteHash !== expected.remoteHash
	) {
		throw new Error(
			"This file changed since the merge was opened, so saving it would overwrite that change. Reopen the merge.",
		);
	}
	await writeLocalFile(deps, path, textToBytes(content));
	return batchKeepLocalOp(deps, result, new Set([path]), ctx);
};

/** Runs `resolve` on each selected conflict; it returns what it left on disk, undefined if it left the path alone. */
async function resolveEach(
	deps: EngineDependencies,
	result: CompareResult,
	paths: ReadonlySet<string>,
	ctx: OperationContext,
	resolve: (path: string) => Promise<ManifestEntry | null | undefined>,
): Promise<{
	conflictPaths: string[];
	localEntries: Map<string, ManifestEntry | null>;
}> {
	const conflictPaths = result.diff.conflicts
		.map((c) => c.path)
		.filter((p) => paths.has(p) && deps.scope.includes(p));
	if (conflictPaths.length === 0) {
		throw new Error("No matching conflicts to resolve");
	}
	const localEntries = new Map<string, ManifestEntry | null>();
	let done = 0;
	await runWithFileConcurrency(
		conflictPaths,
		deps.concurrency ?? DEFAULT_CONCURRENCY,
		(path) =>
			Math.max(
				result.snapshot.files[path]?.size ?? 0,
				result.remote?.files[path]?.size ?? 0,
				deps.state.baseline?.files[path]?.size ?? 0,
			),
		async (path) => {
			const entry = await resolve(path);
			if (entry !== undefined) localEntries.set(path, entry);
			done++;
			ctx.reportProgressSoon(
				`Resolving ${done}/${conflictPaths.length}…`,
				done / conflictPaths.length,
			);
		},
	);
	return {
		conflictPaths: conflictPaths.filter((path) => localEntries.has(path)),
		localEntries,
	};
}
