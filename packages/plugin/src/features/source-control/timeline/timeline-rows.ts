import { formatTimestamp, pluralize } from "@/core/shared";
import type { HistoryDiffTarget } from "@/features/diff";
import type {
	ChangeAction,
	HistoryVersionRef,
	ManifestEntry,
	Resolution,
	SnapshotChanges,
	SnapshotSummary,
	VaultRestorePlan,
} from "@/features/sync";
import { ageTitle, lastOf } from "../history/age-groups";

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

/** What a card says of its changes; all null without a change record. */
export interface ChangeSummary {
	counts: string | null;
	/** Files per kind of change, the non-zero ones. */
	tally: Array<[ChangeAction, number]> | null;
	/** Net bytes moved, signed; null when none moved. */
	netDelta: number | null;
	fileCount: number | null;
}

/** One version: a push, or the last push of a period. */
export interface TimelineRow extends ChangeSummary {
	snapshotId: string;
	at: number;
	res: Resolution | null;
	title: string;
	/** "last of 3 pushes" where the version stands for several. */
	meta: string | null;
	tooltip: string;
	pinned: boolean;
	isHead: boolean;
	restorable: boolean;
	label: string;
	changes: SnapshotChanges | null;
	files: TimelineFileRow[] | null;
}

export function buildTimelineRows(
	snapshots: readonly SnapshotSummary[],
	now: number = Date.now(),
): TimelineRow[] {
	return snapshots.map((snapshot) => {
		const label = snapshot.label?.trim() ?? "";
		const changes = snapshot.files;
		return {
			snapshotId: snapshot.id,
			at: snapshot.at,
			res: snapshot.res,
			title: label || ageTitle(snapshot, now),
			meta: lastOf(snapshot.pushes),
			tooltip: formatTimestamp(snapshot.at),
			...summaryOf(changes),
			pinned: snapshot.pinned,
			isHead: snapshot.isHead,
			restorable: snapshot.restorable,
			label,
			changes,
			// Only expanded cards read it, so the rows of a collapsed push are never built.
			get files() {
				return changes ? fileRowsOf(changes, snapshot.at) : null;
			},
		};
	});
}

export function summaryOf(changes: SnapshotChanges | null): ChangeSummary {
	if (!changes)
		return { counts: null, tally: null, netDelta: null, fileCount: null };
	const tally = tallyOf(changes);
	return {
		counts: countsText(changes),
		tally,
		netDelta: netBytes(changes) || null,
		fileCount: tally.reduce((sum, [, count]) => sum + count, 0),
	};
}

const fileRowCache = new WeakMap<SnapshotChanges, TimelineFileRow[]>();

export function fileRowsOf(
	changes: SnapshotChanges,
	at: number,
): TimelineFileRow[] {
	let rows = fileRowCache.get(changes);
	if (!rows) {
		rows = buildFileRows(changes, at);
		fileRowCache.set(changes, rows);
	}
	return rows;
}

function buildFileRows(
	changes: SnapshotChanges,
	at: number,
): TimelineFileRow[] {
	const rows: TimelineFileRow[] = [];
	for (const [path, entry] of Object.entries(changes.added)) {
		const after = versionRef(entry, at, "after push");
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
		const before = versionRef(change.from, at, "before push");
		const after = versionRef(change.to, at, "after push");
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
		// A merged record keeps the parent's entry for replay; the content right before the deletion is `deletedLast`.
		const last =
			(changes.deletedLast &&
				Object.hasOwn(changes.deletedLast, path) &&
				changes.deletedLast[path]) ||
			entry;
		const before = versionRef(last, at, "before push");
		rows.push({
			path,
			action: "delete",
			version: before,
			before,
			after: null,
			size: last.size,
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
	at: number,
	suffix: string,
): HistoryVersionRef {
	return {
		hash: entry.hash,
		size: entry.size,
		label: `${formatTimestamp(at)} (${suffix})`,
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
export function countsText(changes: SnapshotChanges | null): string | null {
	if (!changes) return null;
	const parts = tallyOf(changes).map(([action, count]) =>
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
