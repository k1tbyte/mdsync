import {
	formatDay,
	formatTimestamp,
	pluralize,
	startOfWeek,
} from "@/core/shared";
import type { Resolution, SnapshotSummary } from "@/features/sync";
import { deviceText } from "../changes/row-formatter";
import { type Session, sessionsOf } from "./sessions";
import {
	buildTimelineRows,
	type ChangeSummary,
	fileRowsOf,
	summaryOf,
	type TimelineFileRow,
	type TimelineRow,
} from "./timeline-rows";

export interface SessionRow extends ChangeSummary {
	key: string;
	at: number;
	firstAt: number;
	res: Resolution | null;
	pinned: boolean;
	title: string;
	meta: string;
	tooltip: string;
	isHead: boolean;
	/** Every push kept: the files lead and the pushes wait behind **Show all**. */
	everyPush: boolean;
	versions: TimelineRow[];
	files: TimelineFileRow[] | null;
}

export interface SessionRowOptions {
	now?: number;
	currentDevice?: { id: string; name: string } | null;
}

export function buildSessionRows(
	snapshots: readonly SnapshotSummary[],
	{ now = Date.now(), currentDevice = null }: SessionRowOptions = {},
): SessionRow[] {
	return sessionsOf(snapshots, now).map((session) => {
		const newest = session.versions[0] as SnapshotSummary;
		const label = newest.label?.trim() ?? "";
		const device = deviceText(newest, currentDevice);
		const everyPush = (session.res ?? "push") === "push";
		const { changes } = session;
		const summary = summaryOf(changes);
		// Pins sit apart from their day, so they carry it instead of counts.
		const meta = session.pinned
			? [formatDay(session.at, now), label ? device : null]
			: [
					everyPush ? null : pluralize(session.versions.length, "version"),
					pluralize(session.pushes, "push", "pushes"),
					summary.fileCount === null
						? null
						: pluralize(summary.fileCount, "file"),
				];
		return {
			key: newest.id,
			at: session.at,
			firstAt: session.firstAt,
			res: session.res,
			pinned: session.pinned,
			title: label || `${device} · ${spanText(session)}`,
			meta: meta.filter(Boolean).join(" · "),
			tooltip:
				session.firstAt === session.at
					? formatTimestamp(session.at)
					: `${formatTimestamp(session.firstAt)} – ${formatTimestamp(session.at)}`,
			...summary,
			isHead: session.versions.some((version) => version.isHead),
			everyPush,
			versions: buildTimelineRows(session.versions, now),
			get files() {
				return changes ? fileRowsOf(changes, session.at) : null;
			},
		};
	});
}

/** A version touched a path containing `query`, lowercase. */
export function touches(row: TimelineRow, query: string): boolean {
	const { changes } = row;
	if (!changes) return false;
	return [changes.added, changes.modified, changes.deleted].some((group) =>
		Object.keys(group).some((path) => path.toLowerCase().includes(query)),
	);
}

/** "08:40 – 12:10", or the days or weeks a packed session spans. */
function spanText({ firstAt, at, res }: Session): string {
	if (res === "1w")
		return range({ day: "numeric", month: "short" }, startOfWeek(firstAt), at);
	if (res === "1d")
		return range(
			{ weekday: "short", day: "numeric", month: "short" },
			firstAt,
			at,
		);
	return range({ hour: "2-digit", minute: "2-digit" }, firstAt, at);
}

function range(
	options: Intl.DateTimeFormatOptions,
	from: number,
	to: number,
): string {
	return new Intl.DateTimeFormat(undefined, options).formatRange(
		Math.min(from, to),
		to,
	);
}
