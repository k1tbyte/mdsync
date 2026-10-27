import { formatRelativeTime, formatTimestamp, pluralize } from "@/core/shared";
import type { HistoryDiffTarget } from "@/features/diff";
import type {
	ChangeAction,
	HistoryVersionRef,
	ManifestEntry,
	SnapshotChanges,
	SnapshotSummary,
	VaultRestorePlan,
} from "@/features/sync";
import { deviceText } from "../changes/row-formatter";
import { timeInDay } from "../history/day-groups";

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
	/** Files per kind of change, the non-zero ones; null without a change record. */
	tally: Array<[ChangeAction, number]> | null;
	/** Net bytes the push moved, signed. Null when it moved none, or is unknown. */
	netDelta: number | null;
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
	return snapshots.map((snapshot) => {
		const relative = formatRelativeTime(snapshot.createdAt, now);
		const label = snapshot.label?.trim() ?? "";
		const device = deviceText(snapshot, options.currentDevice);
		return {
			snapshotId: snapshot.id,
			createdAt: snapshot.createdAt,
			title:
				label ||
				(snapshot.pinned ? relative : timeInDay(snapshot.createdAt, now)),
			// A pin's name replaces the age in the title, and pins sit apart from their day.
			meta: label ? `${relative} · ${device}` : device,
			tooltip: formatTimestamp(snapshot.createdAt),
			counts: countsText(snapshot),
			tally: snapshot.files ? tallyOf(snapshot.files) : null,
			netDelta: (snapshot.files && netBytes(snapshot.files)) || null,
			pinned: snapshot.pinned,
			isHead: snapshot.isHead,
			restorable: snapshot.restorable,
			label,
			// Only expanded cards read it, so the rows of a collapsed push are never built.
			get files() {
				return snapshot.files
					? fileRowsOf(snapshot.files, snapshot.createdAt)
					: null;
			},
		};
	});
}

const fileRowCache = new WeakMap<SnapshotChanges, TimelineFileRow[]>();

function fileRowsOf(
	changes: SnapshotChanges,
	createdAt: number,
): TimelineFileRow[] {
	let rows = fileRowCache.get(changes);
	if (!rows) {
		rows = buildFileRows(changes, createdAt);
		fileRowCache.set(changes, rows);
	}
	return rows;
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

function tallyOf(changes: SnapshotChanges): Array<[ChangeAction, number]> {
	const tally: Array<[ChangeAction, number]> = [
		["add", Object.keys(changes.added).length],
		["modify", Object.keys(changes.modified).length],
		["delete", Object.keys(changes.deleted).length],
	];
	return tally.filter(([, count]) => count > 0);
}

/** "+3 new · 2 changed · 1 removed", dropping the parts that are zero. */
export function countsText(snapshot: SnapshotSummary): string | null {
	if (!snapshot.files) return null;
	const parts = tallyOf(snapshot.files).map(([action, count]) =>
		COUNT_WORDS[action](count),
	);
	return parts.length > 0 ? parts.join(" · ") : "no file changes";
}

const COUNT_WORDS: Record<ChangeAction, (count: number) => string> = {
	add: (count) => `+${count} new`,
	modify: (count) => `${count} changed`,
	delete: (count) => `${count} removed`,
};

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
			`${pluralize(plan.ignored.length, "file")} excluded from sync on this device will not be touched.`,
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
