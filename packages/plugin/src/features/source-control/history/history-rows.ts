import { formatDay, formatRelativeTime, formatTimestamp } from "@/core/shared";
import type { FileVersion, Resolution } from "@/features/sync";
import { deviceText } from "../changes/row-formatter";
import { ageTitle, lastOf } from "./age-groups";

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
	/** The pin's name, else what its group leaves to say (`ageTitle`). */
	title: string;
	meta: string;
	/** Absolute timestamp; the title is relative, which alone is not precise. */
	tooltip: string;
	pinned: boolean;
	/** Where pin actions go: the pin holding this content may sit on a later snapshot. */
	pinId: string | null;
	replayable: boolean;
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
	/** Positions in `versions` to build, in this order; each still compares with its next older version. */
	only?: readonly number[];
}

export function buildHistoryRows(
	versions: readonly FileVersion[],
	options: HistoryRowOptions = {},
): HistoryRow[] {
	const now = options.now ?? Date.now();
	const positions = options.only ?? versions.map((_, index) => index);
	return positions.map((index) => {
		const version = versions[index] as FileVersion;
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
			title: label || ageTitle(version, now),
			meta: [
				// Pins sit apart from their day, so they carry it.
				version.pinId ? formatDay(version.at, now) : null,
				device,
				lastOf(version.pushes),
				version.first ? "first version" : null,
			]
				.filter(Boolean)
				.join(" · "),
			tooltip: formatTimestamp(version.at),
			pinned: version.pinId !== null,
			pinId: version.pinId,
			replayable: version.replayable,
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
