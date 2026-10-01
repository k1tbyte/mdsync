import type { DataAdapter } from "obsidian";
import { DEFAULT_CONCURRENCY } from "@/constants";
import { type EncryptionKey, encryptBytes, sha256Hex } from "@/crypto";
import { sceneOfBytes } from "@/drawing";
import { entryAt, reportWarning, sortedByPath } from "@/shared";
import type { StorageAdapter } from "@/storage/types";
import { REMOTE_OBJECTS_PREFIX } from "@/sync/constants";
import { runWithConcurrency, runWithFileConcurrency } from "@/utils";
import type { VaultIndex } from "@/vault/file-index";
import { deletePath, readBinary, unchangedSince } from "@/vault/io";
import { scanVault } from "@/vault/scanner";
import type { ScopePolicy } from "@/vault/scope";
import { attribute, publisher } from "./authors";
import { advanceBaselineForPaths, mergeFolderArrays } from "./baseline";
import { throwIfCancelled } from "./cancel";
import { reconcileBaselineResetGenerations } from "./config-reset";
import { untouchedSince } from "./content";
import { diff, isUnderUnreadableDir } from "./diff";
import { ownedFiles } from "./foreign";
import { type HistoryConfig, publishManifestWithHistory } from "./history";
import { type LiveNotes, settleLive, writeIncoming } from "./live-notes";
import {
	buildManifest,
	fetchRemoteManifest,
	objectKey,
	reconcileRemoteAgainstBaseline,
} from "./manifest";
import { pullMoves, syncFolders } from "./pull-moves";
import { assertSpacePresent, type Space } from "./space";
import {
	type DiffResult,
	EChangeType,
	type EFileKind,
	type HashCacheEntry,
	type LiveMark,
	type LocalSnapshot,
	type Manifest,
	type ManifestAuthor,
	type ManifestEntry,
	type SessionState,
} from "./types";
import { forgetUploads, rememberUpload, uploadedHere } from "./uploads";

export interface EngineDependencies {
	space: Space;
	adapter: DataAdapter;
	storage: StorageAdapter;
	scope: ScopePolicy;
	/** Absent falls the scanner back to walking the adapter. */
	index?: VaultIndex;
	key: EncryptionKey;
	state: SessionState;
	maxFileBytes: number;
	concurrency?: number;
	/** Aborts long operations between files; see `sync/cancel.ts`. */
	signal?: AbortSignal;
	/** The scan lists the disk too, for files Obsidian's index missed. */
	walkDisk?: boolean;
	/** Found by a walk: scanned until Obsidian's index has them. */
	unindexed?: ReadonlySet<string>;
	onScanProgress?: (scanned: number) => void;
	history?: HistoryConfig;
	live?: LiveNotes;
	/** Whose the content this session publishes is; absent names the device. */
	author?: ManifestAuthor;
}

export interface CompareResult {
	snapshot: LocalSnapshot;
	remote: Manifest | null;
	diff: DiffResult;
	updatedCache: Record<string, HashCacheEntry>;
}

export async function compare(
	deps: EngineDependencies,
	/** Avoids re-downloading a freshly fetched remote head. */
	knownRemote?: Manifest | null,
): Promise<CompareResult> {
	const [{ snapshot, updatedCache }, fetched] = await Promise.all([
		scanVault(
			deps.adapter,
			deps.scope,
			{
				maxFileBytes: deps.maxFileBytes,
				onProgress: deps.onScanProgress,
				concurrency: deps.concurrency,
				index: deps.index,
				expected: deps.state.baseline?.files,
				walk: deps.walkDisk,
				unindexed: deps.unindexed,
			},
			deps.state.hashCache,
		),
		knownRemote === undefined
			? fetchRemoteManifest(deps.storage, deps.key, deps.space.root)
			: Promise.resolve(knownRemote),
	]);
	assertVaultCompatibility(deps.state, fetched);
	assertSpacePresent(deps.space, snapshot, deps.state.baseline);
	const remote = reconcileRemoteAgainstBaseline(
		fetched,
		deps.state.baseline,
		deps.storage,
		deps.key,
	);
	if (fetched && remote !== fetched) {
		reportWarning(
			"Storage returned a stale manifest; using the complete published head.",
			undefined,
			[
				`fetched: ${fetched.snapshotId}`,
				`baseline: ${deps.state.baseline?.snapshotId ?? "none"}`,
			],
		);
	}
	const result = diff({
		local: snapshot,
		remote,
		baseline: remote
			? reconcileBaselineResetGenerations(
					deps.state.baseline,
					remote,
					deps.scope,
				)
			: null,
		includes: (path) => deps.scope.includes(path),
	});
	return { snapshot, remote, diff: result, updatedCache };
}

export async function pushPaths(
	deps: EngineDependencies,
	compareResult: CompareResult,
	paths: ReadonlyArray<string>,
	onProgress?: (done: number, total: number) => void,
	marks: ReadonlyMap<string, LiveMark> = new Map(),
): Promise<Manifest> {
	const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
	const pathSet = new Set(paths);
	const localChanges = compareResult.diff.localChanges.filter(
		(c) => pathSet.has(c.path) && deps.scope.includes(c.path),
	);

	const uploads = collectUploads(localChanges, compareResult.snapshot);
	// Only the head and this device's unpublished uploads prove a blob stays (`uploads.ts`).
	const knownHashes = knownRemoteHashes(compareResult);
	const resumed = new Set(
		uploads
			.filter(
				(entry) =>
					!knownHashes.has(entry.hash) &&
					uploadedHere(deps.storage, entry.hash),
			)
			.map((entry) => entry.hash),
	);
	throwIfCancelled(deps.signal);
	const listed = await listStoredHashes(deps.storage, resumed.size);
	throwIfCancelled(deps.signal);
	deps.storage.prepareWrites?.(
		uploads
			.filter((entry) => !knownHashes.has(entry.hash))
			.map((entry) => objectKey(entry.hash)),
	);
	let done = 0;
	await runWithFileConcurrency(
		uploads,
		concurrency,
		(entry) => entry.size,
		async (entry) => {
			if (!knownHashes.has(entry.hash)) {
				// A listing claiming the blob is there is confirmed against the blob itself.
				const probe =
					resumed.has(entry.hash) &&
					(listed === null || listed.has(entry.hash));
				await uploadObject(deps, entry, probe);
			}
			onProgress?.(++done, uploads.length);
		},
		deps.signal,
	);
	// A manifest for never-uploaded objects would dangle, so a cancelled push publishes nothing; uploaded blobs stay.
	throwIfCancelled(deps.signal);

	const nextFiles = buildPartialFileMap({
		base: compareResult.remote,
		snapshot: compareResult.snapshot,
		localChanges,
		marks,
	});
	const manifest = await publishFileMap(deps, compareResult, nextFiles);
	return manifest;
}

export interface PullResult {
	baseline: Manifest;
	/** What each pulled path now looks like on disk (null = deleted). */
	written: Map<string, ManifestEntry | null>;
	/** Stopped early: `written` holds only what actually landed. */
	cancelled: boolean;
}

export async function pullPaths(
	deps: EngineDependencies,
	compareResult: CompareResult,
	paths: ReadonlyArray<string>,
	onProgress?: (done: number, total: number) => void,
): Promise<PullResult> {
	if (!compareResult.remote) {
		throw new Error("Cannot pull: remote manifest is missing");
	}
	const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
	const pathSet = new Set(paths);
	const remote = compareResult.remote;
	const moved = await pullMoves(deps, compareResult, pathSet);
	const changes = compareResult.diff.remoteChanges.filter(
		(c) =>
			pathSet.has(c.path) &&
			!moved.paths.has(c.path) &&
			deps.scope.includes(c.path),
	);

	const downloads = changes.filter((c) => c.type !== EChangeType.RemoteDelete);
	const deletions = changes.filter((c) => c.type === EChangeType.RemoteDelete);
	const total = downloads.length + deletions.length;
	let done = 0;

	const written = new Map<string, ManifestEntry | null>(moved.written);
	const hashes = new Set<string>();
	for (const change of downloads) {
		const entry = entryAt(remote.files, change.path);
		if (entry) hashes.add(entry.hash);
	}
	deps.storage.prepareReads?.([...hashes].map(objectKey));
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
	await runWithFileConcurrency(
		downloads,
		concurrency,
		(change) => entryAt(remote.files, change.path)?.size ?? 0,
		async (change) => {
			const entry = entryAt(remote.files, change.path);
			if (!entry) throw new Error(`Missing manifest entry for ${change.path}`);
			if (!(await leftAlone(change.path))) {
				const seen = entryAt(compareResult.snapshot.files, change.path);
				const ready = untouchedSince(deps, change.path, seen);
				const local = await writeIncoming(deps, change.path, entry, ready);
				if (local) written.set(change.path, local);
			}
			onProgress?.(++done, total);
		},
		deps.signal,
	);

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

	// Unlike a push nothing is withheld: written files are correct alone. The folder pass is skipped since a
	// partial pull has not reached the whole tree.
	const cancelled = deps.signal?.aborted === true;
	const onDisk = cancelled
		? compareResult.snapshot.emptyFolders
		: await syncFolders(deps, remote, written);

	// `written`, not `paths`: advancing the baseline of a never-downloaded path would turn an unresolved
	// conflict into a local edit pushed over the remote.
	const baseline = advanceBaselineForPaths(
		deps.state.baseline,
		remote,
		new Set(written.keys()),
		onDisk,
		deps.scope,
	);
	return { baseline, written, cancelled };
}

export async function storeObject(
	deps: EngineDependencies,
	known: ReadonlySet<string>,
	bytes: Uint8Array,
): Promise<string> {
	const hash = await sha256Hex(bytes);
	if (known.has(hash)) return hash;
	if (
		uploadedHere(deps.storage, hash) &&
		(await deps.storage.exists(objectKey(hash)))
	) {
		return hash;
	}
	await deps.storage.put(objectKey(hash), await encryptBytes(deps.key, bytes));
	rememberUpload(deps.storage, hash);
	return hash;
}

export async function pushSingleFile(
	deps: EngineDependencies,
	compareResult: CompareResult,
	path: string,
	bytes: Uint8Array,
): Promise<Manifest> {
	if (!deps.scope.includes(path))
		throw new Error("File is outside this device's sync scope.");
	const hash = await storeObject(deps, knownRemoteHashes(compareResult), bytes);
	const kind: EFileKind = deps.scope.classify(path);
	const entry: ManifestEntry = {
		hash,
		size: bytes.length,
		mtime: Date.now(),
		kind,
		scene: await sceneOfBytes(path, bytes),
	};
	const baseFiles = compareResult.remote?.files ?? {};
	const nextFiles: Record<string, ManifestEntry> = {
		...baseFiles,
		[path]: entry,
	};
	return publishFileMap(deps, compareResult, nextFiles);
}

export async function publishFileMap(
	deps: EngineDependencies,
	compareResult: CompareResult,
	files: Record<string, ManifestEntry>,
): Promise<Manifest> {
	const attributed = attribute(
		ownedFiles(files, deps.scope),
		compareResult.remote,
		publisher(deps.state, deps.author),
	);
	const manifest = buildManifest(
		deps.state.deviceId,
		deps.state.deviceName,
		deps.state.vaultId ?? compareResult.remote?.vaultId ?? deps.state.deviceId,
		compareResult.remote,
		{
			files: attributed.files,
			emptyFolders: mergeFolderArrays(
				compareResult.remote?.folders,
				compareResult.snapshot.emptyFolders,
				// Unreadable is not absent: a folder in or under one the scan could not open stays.
				deps.state.baseline?.folders?.filter(
					(dir) =>
						deps.scope.canDescend(dir) &&
						!isUnderUnreadableDir(
							`${dir}/`,
							compareResult.snapshot.unreadableDirs,
						),
				),
				// Another space's folders leave with its frozen entries.
			).filter((dir) => deps.scope.owns(dir)),
		},
	);
	manifest.authors = attributed.authors;
	await publishManifestWithHistory(
		deps.storage,
		deps.key,
		deps.space.root,
		manifest,
		compareResult.remote,
		deps.history,
		deps.state.baseline,
	);
	forgetUploads(
		deps.storage,
		Object.values(manifest.files).map((entry) => entry.hash),
	);
	return manifest;
}

function buildPartialFileMap(input: {
	base: Manifest | null;
	snapshot: LocalSnapshot;
	localChanges: ReadonlyArray<{ path: string; type: EChangeType }>;
	marks: ReadonlyMap<string, LiveMark>;
}): Record<string, ManifestEntry> {
	const next: Record<string, ManifestEntry> = { ...(input.base?.files ?? {}) };
	for (const change of input.localChanges) {
		if (change.type === EChangeType.LocalDelete) {
			delete next[change.path];
			continue;
		}
		const entry = input.snapshot.files[change.path];
		const live = input.marks.get(change.path);
		if (entry) next[change.path] = live ? { ...entry, live } : entry;
	}
	// Sorted paths gzip 8.5% smaller, and an unchanged vault republishes identical bytes.
	return sortedByPath(next);
}

/** Hashes the current remote head references. */
export function knownRemoteHashes(compareResult: CompareResult): Set<string> {
	const hashes = new Set<string>();
	for (const entry of Object.values(compareResult.remote?.files ?? {})) {
		hashes.add(entry.hash);
	}
	return hashes;
}

/** Listings amortize probes when resuming a large upload batch. */
const UPLOAD_LIST_THRESHOLD = 256;

/**
 * Hashes the bucket appeared to hold, or null when per-object probing is cheaper; positives are still
 * confirmed before an upload is skipped.
 */
async function listStoredHashes(
	storage: EngineDependencies["storage"],
	probes: number,
): Promise<Set<string> | null> {
	if (probes < UPLOAD_LIST_THRESHOLD) return null;
	try {
		const keys = await storage.list(REMOTE_OBJECTS_PREFIX);
		return new Set(keys.map((key) => key.slice(REMOTE_OBJECTS_PREFIX.length)));
	} catch {
		// Listing is only an optimisation; the per-object probe still gives a correct push.
		return null;
	}
}

async function uploadObject(
	deps: EngineDependencies,
	entry: { path: string; hash: string },
	probe: boolean,
): Promise<void> {
	if (probe && (await deps.storage.exists(objectKey(entry.hash)))) return;
	const plaintext = await readBinary(deps.adapter, entry.path);
	const verifyHash = await sha256Hex(plaintext);
	if (verifyHash !== entry.hash) {
		throw new Error(`Hash mismatch while uploading ${entry.path}`);
	}
	const blob = await encryptBytes(deps.key, plaintext);
	await deps.storage.put(objectKey(entry.hash), blob);
	rememberUpload(deps.storage, entry.hash);
}

function collectUploads(
	changes: ReadonlyArray<{ path: string; type: EChangeType }>,
	snapshot: LocalSnapshot,
): Array<{ path: string; hash: string; size: number }> {
	// One upload per hash: identical content under two paths would otherwise upload twice.
	const byHash = new Map<
		string,
		{ path: string; hash: string; size: number }
	>();
	for (const change of changes) {
		if (change.type === EChangeType.LocalDelete) continue;
		const entry = entryAt(snapshot.files, change.path);
		if (!entry || byHash.has(entry.hash)) continue;
		byHash.set(entry.hash, {
			path: change.path,
			hash: entry.hash,
			size: entry.size,
		});
	}
	return [...byHash.values()];
}

function assertVaultCompatibility(
	state: SessionState,
	remote: Manifest | null,
): void {
	if (!remote) return;
	if (state.vaultId && state.vaultId !== remote.vaultId) {
		throw new Error(
			"Remote vault id does not match local. Refusing to sync to a different vault.",
		);
	}
}
