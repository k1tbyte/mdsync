import { formatRelativeTime, formatTimestamp } from "@/core/shared";
import type { FileVersion, Resolution } from "@/features/sync";
import { deviceText } from "../changes/row-formatter";
import { ageTitle } from "./age-groups";

export interface HistoryRowVersion {
	hash: string;
	label: string;
	size: number;
}

export interface HistoryRow {
	snapshotId: string;
	createdAt: number;
	at: number;
	res: Resolution | null;
	hash: string;
	size: number;
	/** Bytes gained or lost against the next older version. Absent on the oldest. */
	sizeDelta?: number;
	/** The pin's name, else the age of a pin, else what its group leaves to say (`ageTitle`). */
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
		const label = version.label?.trim() ?? "";
		const device = deviceText(version, options.currentDevice);
		return {
			snapshotId: version.snapshotId,
			createdAt: version.createdAt,
			at: version.at,
			res: version.res,
			hash: version.hash,
			size: version.size,
			sizeDelta: older ? version.size - older.size : undefined,
			title: label || (version.pinned ? relative : ageTitle(version, now)),
			// A pin's name replaces the age in the title, and pins sit apart from their day.
			meta: label ? `${relative} · ${device}` : device,
			tooltip: formatTimestamp(version.createdAt),
			pinned: version.pinned,
			label,
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
