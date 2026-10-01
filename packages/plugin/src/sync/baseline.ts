import { randomId } from "@/crypto";
import { entryAt, sortedByPath } from "@/shared";
import type { ScopePolicy } from "@/vault/scope";
import { reconcileBaselineResetGenerations } from "./config-reset";
import type { CompareResult } from "./engine";
import type {
	HashCacheEntry,
	Manifest,
	ManifestEntry,
	SessionState,
} from "./types";

export function buildSessionState(
	previous: SessionState,
	baseline: Manifest,
	hashCache: Record<string, HashCacheEntry>,
): SessionState {
	return {
		deviceId: previous.deviceId || randomId(),
		deviceName: previous.deviceName,
		vaultId: baseline.vaultId,
		baseline,
		// Single choke point for every persisted hash cache: unsorted additions would rewrite the state file
		// for order alone.
		hashCache: sortedByPath(hashCache),
	};
}

export function advanceSessionAfterPush(
	state: SessionState,
	result: CompareResult,
	manifest: Manifest,
	scope?: ScopePolicy,
): SessionState {
	return {
		deviceId: state.deviceId || randomId(),
		deviceName: state.deviceName,
		vaultId: manifest.vaultId,
		baseline: advanceBaselineForPaths(
			state.baseline,
			manifest,
			publishedDelta(result.remote, manifest),
			result.snapshot.emptyFolders,
			scope,
		),
		hashCache: result.updatedCache,
	};
}

/**
 * Only `paths` advance; `onDisk` holds the empty folders on disk afterwards.
 * Adopting the whole manifest would adopt never-pulled remote changes, which a push then overwrites.
 */
export function advanceBaselineForPaths(
	previous: Manifest | null,
	published: Manifest,
	paths: ReadonlySet<string>,
	onDisk: ReadonlyArray<string>,
	scope?: ScopePolicy,
): Manifest {
	const base = scope
		? reconcileBaselineResetGenerations(previous, published, scope)
		: previous;
	const files: Record<string, ManifestEntry> = {
		...(base?.files ?? {}),
	};
	for (const path of paths) {
		const entry = entryAt(published.files, path);
		if (entry) {
			files[path] = entry;
		} else {
			delete files[path];
		}
	}
	return {
		...published,
		files,
		folders: scope
			? [
					...(base?.folders ?? []).filter((dir) => !scope.canDescend(dir)),
					...majorityFolders(
						base?.folders?.filter((dir) => scope.canDescend(dir)),
						published.folders?.filter((dir) => scope.canDescend(dir)),
						onDisk,
					),
				]
			: majorityFolders(base?.folders, published.folders, onDisk),
	};
}

/** Empty folders at least two of baseline, remote and disk have; a folder on one side only is not agreed on yet. */
export function majorityFolders(
	baseline: ReadonlyArray<string> | undefined,
	remote: ReadonlyArray<string> | undefined,
	local: ReadonlyArray<string>,
): string[] {
	const sides = new Map<string, number>();
	for (const dir of [...(baseline ?? []), ...(remote ?? []), ...local]) {
		sides.set(dir, (sides.get(dir) ?? 0) + 1);
	}
	return [...sides].filter(([, count]) => count >= 2).map(([dir]) => dir);
}

export function publishedDelta(
	before: Manifest | null,
	after: Manifest,
): Set<string> {
	const paths = new Set<string>();
	const beforeFiles = before?.files ?? {};
	for (const [path, entry] of Object.entries(after.files)) {
		if (entryAt(beforeFiles, path)?.hash !== entry.hash) paths.add(path);
	}
	for (const path of Object.keys(beforeFiles)) {
		if (!entryAt(after.files, path)) paths.add(path);
	}
	return paths;
}

/** Uses the local file mtime so pulled files are not re-hashed on the next scan. */
export function mergeWrittenIntoCache(
	written: ReadonlyMap<string, ManifestEntry | null>,
	previous: Record<string, HashCacheEntry>,
): Record<string, HashCacheEntry> {
	const next: Record<string, HashCacheEntry> = { ...previous };
	for (const [path, entry] of written) {
		if (!entry) {
			delete next[path];
			continue;
		}
		const { mtime, size, hash, scene } = entry;
		next[path] = { mtime, size, hash, scene };
	}
	return next;
}

export function resetSessionState(state: SessionState): SessionState {
	return {
		deviceId: state.deviceId || randomId(),
		deviceName: state.deviceName,
		vaultId: null,
		baseline: null,
		hashCache: state.hashCache,
	};
}

/** A baseline folder stays only while both sides still have it, or every push resurrects a deletion. */
export function mergeFolderArrays(
	remoteFolders: ReadonlyArray<string> | undefined,
	localFolders: ReadonlyArray<string>,
	baselineFolders: ReadonlyArray<string> = [],
): string[] {
	const local = new Set(localFolders);
	const remote = new Set(remoteFolders ?? []);
	const merged = new Set([...remote, ...local]);
	for (const dir of baselineFolders) {
		if (!local.has(dir) || !remote.has(dir)) merged.delete(dir);
	}
	return Array.from(merged);
}
