import { formatRelativeTime, formatTimestamp } from "@/shared";
import type { FileVersion } from "@/sync/history";
import { deviceText } from "./row-formatter";

export interface HistoryRowVersion {
	hash: string;
	label: string;
	size: number;
}

export interface HistoryRow {
	snapshotId: string;
	createdAt: number;
	hash: string;
	size: number;
	/** Bytes gained or lost against the next older version. Absent on the oldest. */
	sizeDelta?: number;
	/** Relative time, or the pin's name once it has one. */
	title: string;
	meta: string;
	/** Absolute timestamp; the title is relative, which alone is not precise. */
	tooltip: string;
	pinned: boolean;
	/** The pin's own name, empty when it has none. Distinct from the displayed title. */
	label: string;
	isLatest: boolean;
	/** Names this version when it heads a diff pane. */
	version: HistoryRowVersion;
	/** The next older version, for compare-with-previous. Absent on the oldest. */
	previous?: HistoryRowVersion;
}

export interface HistoryRowOptions {
	now?: number;
	currentDevice?: { id: string; name: string } | null;
}

export function buildHistoryRows(
	versions: readonly FileVersion[],
	options: HistoryRowOptions = {},
): HistoryRow[] {
	const now = options.now ?? Date.now();
	return versions.map((version, index) => {
		const older = versions[index + 1];
		const relative = formatRelativeTime(version.createdAt, now);
		return {
			snapshotId: version.snapshotId,
			createdAt: version.createdAt,
			hash: version.hash,
			size: version.size,
			sizeDelta: older ? version.size - older.size : undefined,
			title: version.label?.trim() || relative,
			meta: deviceText(version, options.currentDevice),
			tooltip: formatTimestamp(version.createdAt),
			pinned: version.pinned,
			label: version.label?.trim() ?? "",
			isLatest: index === 0,
			version: { hash: version.hash, label: relative, size: version.size },
			previous: older
				? {
						hash: older.hash,
						label: formatRelativeTime(older.createdAt, now),
						size: older.size,
					}
				: undefined,
		};
	});
}
