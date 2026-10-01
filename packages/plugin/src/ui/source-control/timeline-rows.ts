import {
	formatRelativeTime,
	formatSizeDelta,
	formatTimestamp,
	pluralize,
} from "@/shared/format";
import type {
	SnapshotChanges,
	SnapshotSummary,
	VaultRestorePlan,
} from "@/sync/history";
import type { HistoryVersionRef } from "@/sync/projection";
import type { ManifestEntry } from "@/sync/types";
import type { ChangeAction } from "@/ui/common";
import type { HistoryDiffTarget } from "@/ui/source-control-view";
import { deviceText } from "./row-formatter";

export interface TimelineFileRow {
	path: string;
	action: ChangeAction;
	version: HistoryVersionRef;
	before: HistoryVersionRef | null;
	after: HistoryVersionRef | null;
	/** Bytes the file holds after this push, or held before a deletion. */
	size: number;
	/** Bytes gained or lost here. Only a modification has both sides. */
	sizeDelta?: number;
}

export interface TimelineRow {
	snapshotId: string;
	createdAt: number;
	title: string;
	meta: string;
	tooltip: string;
	counts: string | null;
	/** Net bytes the push moved, signed. Null when it moved none, or is unknown. */
	netSize: string | null;
	pinned: boolean;
	isHead: boolean;
	restorable: boolean;
	label: string;
	files: TimelineFileRow[] | null;
}

export interface TimelineRowOptions {
	now?: number;
	currentDevice?: { id: string; name: string } | null;
}

export function buildTimelineRows(
	snapshots: readonly SnapshotSummary[],
	options: TimelineRowOptions = {},
): TimelineRow[] {
	const now = options.now ?? Date.now();
	return snapshots.map((snapshot) => ({
		snapshotId: snapshot.id,
		createdAt: snapshot.createdAt,
		title:
			snapshot.label?.trim() || formatRelativeTime(snapshot.createdAt, now),
		meta: deviceText(snapshot, options.currentDevice),
		tooltip: formatTimestamp(snapshot.createdAt),
		counts: countsText(snapshot),
		netSize: snapshot.files ? formatSizeDelta(netBytes(snapshot.files)) : null,
		pinned: snapshot.pinned,
		isHead: snapshot.isHead,
		restorable: snapshot.restorable,
		label: snapshot.label?.trim() ?? "",
		files: snapshot.files
			? buildFileRows(snapshot.files, snapshot.createdAt)
			: null,
	}));
}

function buildFileRows(
	changes: SnapshotChanges,
	createdAt: number,
): TimelineFileRow[] {
	const rows: TimelineFileRow[] = [];
	for (const [path, entry] of Object.entries(changes.added)) {
		const after = versionRef(entry, createdAt, "after push");
		rows.push({
			path,
			action: "add",
			version: after,
			before: null,
			after,
			size: entry.size,
		});
	}
	for (const [path, change] of Object.entries(changes.modified)) {
		const before = versionRef(change.from, createdAt, "before push");
		const after = versionRef(change.to, createdAt, "after push");
		rows.push({
			path,
			action: "modify",
			version: after,
			before,
			after,
			size: change.to.size,
			sizeDelta: change.to.size - change.from.size,
		});
	}
	for (const [path, entry] of Object.entries(changes.deleted)) {
		const before = versionRef(entry, createdAt, "before push");
		rows.push({
			path,
			action: "delete",
			version: before,
			before,
			after: null,
			size: entry.size,
		});
	}
	return rows.sort((a, b) => a.path.localeCompare(b.path));
}

/** What the push added minus what it removed, so growth is readable at a glance. */
function netBytes(changes: SnapshotChanges): number {
	let total = 0;
	for (const entry of Object.values(changes.added)) total += entry.size;
	for (const change of Object.values(changes.modified))
		total += change.to.size - change.from.size;
	for (const entry of Object.values(changes.deleted)) total -= entry.size;
	return total;
}

function versionRef(
	entry: ManifestEntry,
	createdAt: number,
	suffix: string,
): HistoryVersionRef {
	return {
		hash: entry.hash,
		size: entry.size,
		label: `${formatTimestamp(createdAt)} (${suffix})`,
	};
}

/** "+3 new · 2 changed · 1 removed", dropping the parts that are zero. */
export function countsText(snapshot: SnapshotSummary): string | null {
	if (!snapshot.files) return null;
	const { added, modified, deleted } = snapshot.files;
	const addedCount = Object.keys(added).length;
	const modifiedCount = Object.keys(modified).length;
	const deletedCount = Object.keys(deleted).length;
	const parts = [
		addedCount > 0 ? `+${addedCount} new` : null,
		modifiedCount > 0 ? `${modifiedCount} changed` : null,
		deletedCount > 0 ? `${deletedCount} removed` : null,
	].filter((part): part is string => part !== null);
	return parts.length > 0 ? parts.join(" · ") : "no file changes";
}

export function timelineDiffTarget(
	file: TimelineFileRow,
	mode: "current" | "change" = "current",
): HistoryDiffTarget {
	if (mode === "change") {
		return {
			hash: file.version.hash,
			label: file.version.label,
			size: file.version.size,
			change: { before: file.before, after: file.after },
		};
	}
	return {
		hash: file.version.hash,
		label: file.version.label,
		size: file.version.size,
		previewIfMissing: true,
	};
}

/** Lines for the confirmation, ordered so the destructive count is not buried. */
export function describeRestorePlan(plan: VaultRestorePlan): string[] {
	const lines: string[] = [];
	if (plan.remove.length > 0) {
		lines.push(
			`${pluralize(plan.remove.length, "file")} will be moved to the trash.`,
		);
	}
	if (plan.write.length > 0) {
		lines.push(
			`${pluralize(plan.write.length, "file")} will be written or restored.`,
		);
	}
	if (plan.unchanged > 0) {
		lines.push(`${pluralize(plan.unchanged, "file")} already up to date.`);
	}
	if (plan.ignored.length > 0) {
		lines.push(
			`${pluralize(plan.ignored.length, "file")} excluded by ignore rules will not be touched.`,
		);
	}
	if (lines.length === 0)
		lines.push("The vault already matches this snapshot.");
	return lines;
}

/** A few example paths, so the counts are not the only thing to go on. */
export function samplePaths(paths: readonly string[], limit = 5): string[] {
	const shown = paths.slice(0, limit).map((path) => `• ${path}`);
	if (paths.length > limit) shown.push(`• …and ${paths.length - limit} more`);
	return shown;
}
