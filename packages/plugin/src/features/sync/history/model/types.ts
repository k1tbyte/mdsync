import type { SnapshotChanges } from "../types";

/** Finest first: each one's groups nest inside the next one's. */
export type Resolution = "push" | "10m" | "1h" | "1d" | "1w" | "counts";

/** UTC hours since the epoch -> [pushes, paths changed]. */
export type Activity = Record<number, [number, number]>;

/** What a pushing device writes, before storage has dated it. */
export interface PushRecord {
	v: 1;
	vaultId: string;
	id: string;
	parentId: string | null;
	createdAt: number;
	deviceId: string;
	deviceName?: string;
	changes: SnapshotChanges;
}

/** What GC writes: one resolution over one group. Immutable; a new content is a new object. */
export interface HistoryObject {
	v: 1;
	vaultId: string;
	res: Resolution;
	group: number;
	/** Chain order, oldest first; empty for counts. */
	records: StoredRecord[];
	/** Counts only: the activity of records it outlived. */
	activity?: Activity;
	/** Counts only: the newest record it dropped, where the chain now ends by retention, not by a gap. */
	lastId?: string;
	/** Keys this object replaces. */
	consumed: string[];
}

/** A push, or a merged run of pushes: the last one's id and device, the first one's parent. */
export interface StoredRecord {
	id: string;
	parentId: string | null;
	createdAt: number;
	deviceId: string;
	deviceName?: string;
	changes: SnapshotChanges;
	/** Storage time of the newest push in it: periods and retention go by it, never by a device clock. */
	at: number;
	firstAt: number;
	pushes: number;
	activity: Activity;
}
