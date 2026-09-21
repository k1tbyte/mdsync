import { formatDayLabel } from "@/shared/format";

export interface DayGroup<T> {
	label: string;
	rows: T[];
}

/** Buckets already-ordered rows by calendar day, keeping their order. */
export function groupByDay<T extends { createdAt: number }>(
	rows: readonly T[],
	now: number = Date.now(),
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
