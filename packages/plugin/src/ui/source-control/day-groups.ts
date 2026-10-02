import { formatDayLabel } from "@/shared";

export interface DayGroup<T> {
	label: string;
	rows: T[];
}

export const PINNED_LABEL = "Pinned";

/** Pinned rows lead under their own heading; the rest bucket by calendar day, keeping their order. */
export function groupRows<T extends { createdAt: number; pinned: boolean }>(
	rows: readonly T[],
	now: number = Date.now(),
): DayGroup<T>[] {
	const pinned = rows.filter((row) => row.pinned);
	const groups = groupByDay(
		rows.filter((row) => !row.pinned),
		now,
	);
	if (pinned.length > 0) groups.unshift({ label: PINNED_LABEL, rows: pinned });
	return groups;
}

function groupByDay<T extends { createdAt: number }>(
	rows: readonly T[],
	now: number,
): DayGroup<T>[] {
	const groups: DayGroup<T>[] = [];
	for (const row of rows) {
		const label = formatDayLabel(row.createdAt, now);
		const last = groups[groups.length - 1];
		if (last?.label === label) last.rows.push(row);
		else groups.push({ label, rows: [row] });
	}
	return groups;
}
