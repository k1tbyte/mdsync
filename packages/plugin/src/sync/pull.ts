/** The pull: moves, downloads and deletions land, then the baseline follows what did. */

import { DEFAULT_CONCURRENCY } from "@/constants";
import { entryAt } from "@/shared";
import { runWithConcurrency, runWithFileConcurrency } from "@/utils";
import { deletePath, unchangedSince } from "@/vault/io";
import { advanceBaselineForPaths } from "./baseline";
import { baseStep } from "./cut-short";
import type { CompareResult, EngineDependencies } from "./engine";
import type { Target } from "./journal";
import { coldSince, settleLive, writeIncoming } from "./live-notes";
import { objectKey } from "./manifest";
import { pullMoves, syncFolders } from "./pull-moves";
import { EChangeType, type Manifest, type ManifestEntry } from "./types";

export interface PullResult {
	baseline: Manifest;
	/** What each pulled path now looks like on disk (null = deleted). */
	written: Map<string, ManifestEntry | null>;
	/** Stopped early: `written` holds only what actually landed. */
	cancelled: boolean;
	/** What stopped it, `written` holding what landed before: the caller saves that, then throws it. */
	failed?: unknown;
}

export async function pullPaths(
	deps: EngineDependencies,
	compareResult: CompareResult,
	paths: ReadonlyArray<string>,
	onProgress?: (done: number, total: number) => void,
): Promise<PullResult> {
	const { remote } = compareResult;
	if (!remote) throw new Error("Cannot pull: remote manifest is missing");
	const written = new Map<string, ManifestEntry | null>();
	// An error stops it as a cancel does. Left on the old baseline, what landed would read as this device's
	// edit, and a change made there elsewhere meanwhile would be undone.
	let failed: unknown;
	let onDisk = compareResult.snapshot.emptyFolders;
	try {
		await land(
			deps,
			compareResult,
			remote,
			new Set(paths),
			written,
			onProgress,
		);
		// Unlike a push nothing is withheld: written files are correct alone. The folder pass waits for a
		// whole pull: a partial one has not reached the whole tree.
		if (!deps.signal?.aborted)
			onDisk = await syncFolders(deps, remote, written);
	} catch (err) {
		failed = err;
	}
	const cancelled = deps.signal?.aborted === true;
	// `written`, not `paths`: advancing the baseline of a never-downloaded path would turn an unresolved
	// conflict into a local edit pushed over the remote.
	const baseline = advanceBaselineForPaths(
		deps.state.baseline,
		remote,
		new Set(written.keys()),
		onDisk,
		deps.scope,
	);
	return { baseline, written, cancelled, failed };
}

/** Records each path in `written` as it lands. */
async function land(
	deps: EngineDependencies,
	compareResult: CompareResult,
	remote: Manifest,
	pathSet: ReadonlySet<string>,
	written: Map<string, ManifestEntry | null>,
	onProgress?: (done: number, total: number) => void,
): Promise<void> {
	const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
	const moved = await pullMoves(deps, compareResult, pathSet, written);
	const changes = compareResult.diff.remoteChanges.filter(
		(c) =>
			pathSet.has(c.path) && !moved.has(c.path) && deps.scope.includes(c.path),
	);

	const downloads = changes.filter((c) => c.type !== EChangeType.RemoteDelete);
	const deletions = changes.filter((c) => c.type === EChangeType.RemoteDelete);
	const total = downloads.length + deletions.length;
	let done = 0;

	const hashes = new Set<string>();
	// Overwrites, and room snapshots for their merge base: any other new file cut short has no base, so it is
	// never merged.
	const targets = new Map<string, Target>();
	for (const change of downloads) {
		const entry = entryAt(remote.files, change.path);
		if (!entry) continue;
		hashes.add(entry.hash);
		if (entry.live || entryAt(compareResult.snapshot.files, change.path)) {
			const base = baseStep(deps, change.path, entry);
			targets.set(change.path, { hash: entry.hash, live: entry.live, base });
		}
	}
	deps.storage.prepareReads?.([...hashes].map(objectKey));
	// One durable claim for the batch, not one per file.
	const claims = await deps.journal?.claim(deps.space, targets);
	/** True when live editing settled the path: an open room keeps its file. */
	const settledLive = async (path: string): Promise<boolean> => {
		const side = await settleLive(deps, compareResult, path);
		if (side === "local") {
			written.set(path, entryAt(compareResult.snapshot.files, path) ?? null);
		}
		return side === "local" || side === "later";
	};
	const leftAlone = async (path: string): Promise<boolean> =>
		(await settledLive(path)) ||
		!(await unchangedSince(
			deps.adapter,
			path,
			entryAt(compareResult.snapshot.files, path),
		));
	try {
		await runWithFileConcurrency(
			downloads,
			concurrency,
			(change) => entryAt(remote.files, change.path)?.size ?? 0,
			async (change) => {
				const entry = entryAt(remote.files, change.path);
				if (!entry) {
					throw new Error(`Missing manifest entry for ${change.path}`);
				}
				if (!(await leftAlone(change.path))) {
					const seen = entryAt(compareResult.snapshot.files, change.path);
					const ready = coldSince(deps, change.path, seen);
					const local = await writeIncoming(deps, change.path, entry, {
						ready,
						claims,
					});
					if (local) written.set(change.path, local);
				}
				onProgress?.(++done, total);
			},
			deps.signal,
		);
	} finally {
		if (claims) await deps.journal?.settle(claims);
	}

	await runWithConcurrency(
		deletions,
		concurrency,
		async (change) => {
			if (!(await leftAlone(change.path))) {
				await deletePath(deps.adapter, change.path);
				written.set(change.path, null);
			}
			onProgress?.(++done, total);
		},
		deps.signal,
	);
}
