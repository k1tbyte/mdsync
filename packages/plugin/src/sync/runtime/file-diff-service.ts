import { isTextMergeCandidate } from "@/sync/auto-merge";
import {
	loadBaselineText,
	loadLocalText,
	loadRemoteText,
} from "@/sync/content";
import { DiffCache, type DiffCacheInput } from "@/sync/diff-cache";
import type { CompareResult, EngineDependencies } from "@/sync/engine";
import type { FileDiffModel } from "@/sync/projection";
import type { Space } from "@/sync/space";
import type {
	Conflict,
	DiffResult,
	EChangeType,
	FileChange,
	ManifestEntry,
	Move,
} from "@/sync/types";

export interface PathStatus {
	change?: FileChange;
	conflict?: Conflict;
	/** A move lands at its new path; its change may sit at the old one. */
	move?: Move;
}

export interface BaselineSnapshot {
	hash: string;
	text: string;
}

interface FileDiffServiceDeps {
	/** The session of `space`, else of the space that owns the path. */
	openSession: (
		path: string,
		space?: Space,
	) => Promise<EngineDependencies | null>;
	getResult: () => CompareResult | null;
	/** The share bases kept in a storage's slot. */
	shareBases: (
		identity: string,
	) => Readonly<Record<string, ManifestEntry>> | undefined;
}

export class FileDiffService {
	private readonly diffCache = new DiffCache();
	/** Keyed by diff identity: a new compare result replaces it wholesale. */
	private index: { diff: DiffResult; paths: PathIndex } | null = null;

	constructor(private readonly deps: FileDiffServiceDeps) {}

	getStatusForPath(path: string): PathStatus | null {
		const index = this.pathIndex();
		if (!index) return null;
		const move = index.moved.get(path);
		const change =
			index.change.get(path) ?? (move && index.change.get(move.from));
		const conflict = index.conflict.get(path);
		if (!change && !conflict) return null;
		return { change, conflict, move };
	}

	getChangedPathStatuses(): ReadonlyMap<string, EChangeType | "conflict"> {
		return this.pathIndex()?.status ?? EMPTY_STATUSES;
	}

	/** One pass instead of a scan per lookup: at 20k changes the file explorer alone asks ~40 times a refresh. */
	private pathIndex(): PathIndex | null {
		const diff = this.deps.getResult()?.diff;
		if (!diff) return null;
		if (this.index?.diff === diff) return this.index.paths;
		const paths = buildPathIndex(diff);
		this.index = { diff, paths };
		return paths;
	}

	async getConflictThreeWay(path: string): Promise<{
		base: string;
		local: string;
		remote: string;
		expected: { localHash: string; remoteHash: string };
	} | null> {
		const result = this.deps.getResult();
		if (!result) return null;
		const conflict = this.pathIndex()?.conflict.get(path);
		if (!conflict?.baselineHash) return null;
		const session = await this.deps.openSession(path);
		if (!session) return null;
		// Pre-flight size/extension so binary or oversized conflicts return null before downloading.
		const mergeable = await isTextMergeCandidate(
			session,
			path,
			result.remote,
			session.state.baseline,
		);
		if (!mergeable) return null;
		const fetch = { storage: session.storage, key: session.key };
		const [base, local, remote] = await Promise.all([
			loadRemoteText(fetch, conflict.baselineHash),
			loadLocalText(session.adapter, path),
			loadRemoteText(fetch, conflict.remoteHash),
		]);
		if (base === null || local === null || remote === null) return null;
		return {
			base,
			local,
			remote,
			expected: {
				localHash: conflict.localHash,
				remoteHash: conflict.remoteHash,
			},
		};
	}

	async getFileDiff(path: string): Promise<FileDiffModel | null> {
		return this.fileDiff(path, false);
	}

	/**
	 * Works without a change status (live editor diffs). Null if missing from baseline or binary. `space`:
	 * another space's baseline, such as the vault's frozen entries under a share root.
	 */
	async loadBaselineForPath(
		path: string,
		space?: Space,
	): Promise<BaselineSnapshot | null> {
		const session = await this.deps.openSession(path, space);
		if (!session) return null;
		const entry =
			session.state.baseline?.files[path] ??
			this.deps.shareBases(session.storage.identity())?.[path];
		if (!entry) return null;
		const text = await loadBaselineText(
			{ storage: session.storage, key: session.key },
			{ files: { [path]: entry } },
			path,
		);
		if (text === null) return null;
		return { hash: entry.hash, text };
	}

	async getForcedFileDiff(path: string): Promise<FileDiffModel | null> {
		return this.fileDiff(path, true);
	}

	clear(): void {
		this.diffCache.clear();
		this.index = null;
	}

	private async fileDiff(
		path: string,
		forceText: boolean,
	): Promise<FileDiffModel | null> {
		const status = this.getStatusForPath(path);
		if (!status) return null;
		const result = this.deps.getResult();
		if (!result) return null;
		const session = await this.deps.openSession(path);
		if (!session) return null;
		const input: DiffCacheInput = {
			path,
			status,
			deps: session,
			remote: result.remote,
			forceText,
		};
		return this.diffCache.get(input);
	}
}

interface PathIndex {
	change: Map<string, FileChange>;
	conflict: Map<string, Conflict>;
	status: Map<string, EChangeType | "conflict">;
	/** By new path. */
	moved: Map<string, Move>;
}

const EMPTY_STATUSES: ReadonlyMap<string, EChangeType | "conflict"> = new Map();

function buildPathIndex(diff: DiffResult): PathIndex {
	const change = new Map<string, FileChange>();
	const conflict = new Map<string, Conflict>();
	const status = new Map<string, EChangeType | "conflict">();
	// `change` keeps the local side and `status` the remote one; callers depend on their own answer.
	for (const entry of diff.localChanges) {
		if (!change.has(entry.path)) change.set(entry.path, entry);
		status.set(entry.path, entry.type);
	}
	for (const entry of diff.remoteChanges) {
		if (!change.has(entry.path)) change.set(entry.path, entry);
		status.set(entry.path, entry.type);
	}
	for (const entry of diff.conflicts) {
		if (!conflict.has(entry.path)) conflict.set(entry.path, entry);
		status.set(entry.path, "conflict");
	}
	const moved = new Map(diff.moves.map((move) => [move.to, move]));
	return { change, conflict, status, moved };
}
