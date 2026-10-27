import type { EFileKind, ManifestEntry } from "../types";

export interface HistoryConfig {
	/** ms past which only activity counts are kept; null keeps every tier forever. */
	horizon: number | null;
}

export interface SnapshotEntry {
	id: string;
	parentId: string | null;
	createdAt: number;
	deviceId: string;
	deviceName?: string;
	/** Pinned snapshots are never evicted and keep a full manifest under `pins/`. */
	pinned?: boolean;
	label?: string;
}

export interface FileChange {
	from: ManifestEntry;
	to: ManifestEntry;
}

/** Carries both sides so a restore needs no replay and a lost update leaves a detectable gap, not a corrupted chain. */
export interface SnapshotChanges {
	added: Record<string, ManifestEntry>;
	modified: Record<string, FileChange>;
	/** The parent's entry, which replay restores. */
	deleted: Record<string, ManifestEntry>;
	/** A merged record's content right before the deletion, where it differs from `deleted`. */
	deletedLast?: Record<string, ManifestEntry>;
}

export interface HistoryLog {
	version: number;
	/** Newest first. */
	snapshots: SnapshotEntry[];
	changes: Record<string, SnapshotChanges>;
}

export interface FileVersion {
	snapshotId: string;
	hash: string;
	size: number;
	mtime: number;
	kind: EFileKind;
	createdAt: number;
	deviceId: string;
	deviceName?: string;
	pinned: boolean;
	/** Name the user gave the pin, if any. */
	label?: string;
}

export interface DeletedFile {
	path: string;
	/** Content the file had when it went away, so it can be restored directly. */
	entry: ManifestEntry;
	/** Snapshot that removed the file, or the pinned snapshot it was last seen in. */
	snapshotId: string;
	source: "deleted" | "pinned";
	/** Name of the pin this was last seen in, when it came from one. */
	label?: string;
	createdAt: number;
	deviceId: string;
	deviceName?: string;
	/** A pin holds this content, so retention never drops it. */
	pinned: boolean;
	/** The earliest time retention may drop this content; null while pinned or nothing expires. */
	keptUntil: number | null;
}

export interface DeletedFilesResult {
	files: DeletedFile[];
	/**
	 * The log does not describe HEAD yet (updates are best-effort), so recent deletions are unknown; the next
	 * push clears this.
	 */
	lagging: boolean;
	/** The walk stopped at a missing change record: older deletions are unknown unless a pin covers them. */
	truncated: boolean;
}

export interface SnapshotSummary {
	id: string;
	createdAt: number;
	deviceId: string;
	deviceName?: string;
	pinned: boolean;
	label?: string;
	/** Null when no change record explains this snapshot, so its contents are unknown. */
	files: SnapshotChanges | null;
	/** See `DeletedFile.keptUntil`; null when pinned. */
	keptUntil: number | null;
	/** Reachable by replay from HEAD, which a restore needs. */
	restorable: boolean;
	/** True when this snapshot is the actual remote HEAD, determined by snapshotId. */
	isHead: boolean;
}

export interface SnapshotListResult {
	snapshots: SnapshotSummary[];
	/** The log does not describe HEAD yet, so the newest push is missing here. */
	lagging: boolean;
}
