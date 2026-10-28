import { formatDay, formatDayLabel, startOfWeek } from "@/core/shared";
import { RESOLUTIONS, type Resolution } from "@/features/sync";

const HOUR_MS = 3_600_000;

export const PINNED_LABEL = "Pinned";

export interface Aged {
	at: number;
	/** Null off the walk, dated by its own clock like a single push. */
	res: Resolution | null;
	pinned: boolean;
}

export interface AgeGroup<T> {
	label: string;
	/** The coarsest resolution kept in it, where it differs from the group above. */
	chip: Resolution | null;
	rows: T[];
}

/** Pinned rows lead; the rest group as finely as history keeps them: the last hour, days, weeks, months. */
export function groupByAge<T extends Aged>(
	rows: readonly T[],
	now: number = Date.now(),
): AgeGroup<T>[] {
	const pinned = rows.filter((row) => row.pinned);
	const groups: AgeGroup<T>[] =
		pinned.length > 0
			? [{ label: PINNED_LABEL, chip: null, rows: pinned }]
			: [];
	const aged: Array<{ label: string; res: Resolution; rows: T[] }> = [];
	for (const row of rows) {
		if (row.pinned) continue;
		const label = ageLabel(row, now);
		const res = row.res ?? "push";
		const last = aged[aged.length - 1];
		if (last?.label !== label) aged.push({ label, res, rows: [row] });
		else {
			last.rows.push(row);
			if (RESOLUTIONS.indexOf(res) > RESOLUTIONS.indexOf(last.res))
				last.res = res;
		}
	}
	let above: Resolution | null = null;
	for (const { label, res, rows } of aged) {
		groups.push({ label, chip: res === above ? null : res, rows });
		above = res;
	}
	return groups;
}

export function ageLabel(
	{ at, res }: Pick<Aged, "at" | "res">,
	now: number = Date.now(),
): string {
	if (res === "1w")
		return new Date(at).toLocaleDateString(undefined, {
			month: "long",
			year: "numeric",
		});
	if (res === "1d") {
		const monday = new Date(startOfWeek(at));
		const sunday = new Date(monday);
		sunday.setDate(monday.getDate() + 6);
		return new Intl.DateTimeFormat(undefined, {
			month: "short",
			day: "numeric",
		}).formatRange(monday, sunday);
	}
	if ((res ?? "push") === "push" && now - at < HOUR_MS) return "Last hour";
	return formatDayLabel(at, now);
}

/** A row's title under its group: the time in a day, the day in a week, the week in a month. */
export function ageTitle(
	{ at, res }: Pick<Aged, "at" | "res">,
	now: number = Date.now(),
): string {
	if (res === "1w") return `Week of ${formatDay(startOfWeek(at), now, false)}`;
	if (res === "1d") return formatDay(at, now);
	return clockTime(at);
}

export function clockTime(ms: number): string {
	return new Date(ms).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
	});
}
