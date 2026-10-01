export const EFileKind = {
	Vault: "vault",
	Config: "config",
	Plugin: "plugin",
} as const;
export type EFileKind = (typeof EFileKind)[keyof typeof EFileKind];

export interface ManifestEntry {
	hash: string;
	size: number;
	mtime: number;
	kind: EFileKind;
	/** The content is exactly this live room's text at `seq`. */
	live?: LiveMark;
	/** Who published this content: an index into the manifest's `authors`. */
	by?: number;
	/** A drawing's scene fingerprint: saves of one scene differ only in view state. */
	scene?: string;
}

/** A person in a share, a device in the vault. */
export interface ManifestAuthor {
	key: string;
	name: string;
}

export interface LiveMark {
	/** The note's first docId: rotations keep it and bump `gen`. */
	doc: string;
	gen: number;
	seq: number;
}

export interface Manifest {
	version: number;
	vaultId: string;
	snapshotId: string;
	parentSnapshotId: string | null;
	createdAt: number;
	deviceId: string;
	deviceName?: string;
	files: Record<string, ManifestEntry>;
	/** Leaf empty directories that have no files and would otherwise not be created. */
	folders?: string[];
	/** Reset generations by config-directory/category; resets never delete local files. */
	resetGenerations?: Record<string, number>;
	/** Whom the entries' `by` indices name. */
	authors?: ManifestAuthor[];
}

export interface HashCacheEntry {
	mtime: number;
	size: number;
	hash: string;
	scene?: string;
}

/**
 * Per-storage remembered state. One entry per `storage.identity()` so switching
 * backends does not lose what we adopted/synced elsewhere.
 */
export interface StorageState {
	vaultId: string;
	baseline: Manifest | null;
	/** The share's folder the baseline's paths sit under; absent for the vault. */
	root?: string;
	/** The share this state is of; absent for the vault. */
	space?: string;
	/** Frozen entries the baseline forgot before their share here took them (`heldShareBases`). */
	shareBases?: Record<string, ManifestEntry>;
}

/**
 * What gets persisted to state.json. Device identity + a per-storage map +
 * a local content cache that is storage-agnostic (it indexes the vault's own
 * files by mtime/size/hash).
 */
export interface LocalState {
	deviceId: string;
	deviceName?: string;
	storages: Record<string, StorageState>;
	hashCache: Record<string, HashCacheEntry>;
}

/**
 * The flat view the sync engine and operations work with. Built per session
 * from the active storage's slot in {@link LocalState.storages}; the
 * controller translates back when persisting.
 */
export interface SessionState {
	deviceId: string;
	deviceName?: string;
	vaultId: string | null;
	baseline: Manifest | null;
	hashCache: Record<string, HashCacheEntry>;
}

export interface LocalSnapshot {
	files: Record<string, ManifestEntry>;
	skipped: SkippedFile[];
	emptyFolders: string[];
	ignoredPaths: string[];
	/**
	 * Directories the adapter refused to list. Everything under them is unknown
	 * rather than absent, and the diff has to leave those paths alone: an empty
	 * string means the vault root itself could not be listed.
	 */
	unreadableDirs: string[];
	/** On disk yet missing from Obsidian's index: synced, shown by Obsidian only after a restart. */
	unindexed?: string[];
}

/** Left out of the sync, and why. */
export type SkippedFile =
	| { path: string; reason: "too-large"; size: number }
	| { path: string; reason: "unreadable"; detail?: string }
	/** Its name differs from `other`'s only in case. */
	| { path: string; reason: "case-clash"; other: string };

export const EChangeType = {
	LocalAdd: "local-add",
	LocalModify: "local-modify",
	LocalDelete: "local-delete",
	RemoteAdd: "remote-add",
	RemoteModify: "remote-modify",
	RemoteDelete: "remote-delete",
} as const;
export type EChangeType = (typeof EChangeType)[keyof typeof EChangeType];

export interface FileChange {
	path: string;
	type: EChangeType;
	localHash: string | null;
	remoteHash: string | null;
}

export interface Conflict {
	path: string;
	localHash: string;
	remoteHash: string;
	baselineHash: string | null;
}

/**
 * A file moved within its space, on the `side` that moved it: its two paths
 * stay in the change lists, and act as one. The other side's edit follows it.
 */
export interface Move {
	from: string;
	to: string;
	side: "local" | "remote";
}

export interface DiffResult {
	localChanges: FileChange[];
	remoteChanges: FileChange[];
	conflicts: Conflict[];
	moves: Move[];
	/**
	 * Paths both sides changed to the same content. Nothing to sync, but the
	 * baseline still points at the old hash: leaving it there turns the next
	 * edit on either side into a spurious conflict.
	 */
	converged: string[];
	remoteMoved: boolean;
}
