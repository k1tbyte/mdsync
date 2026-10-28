import { describe, expect, it } from "vitest";
import {
	type Aged,
	ageTitle,
	groupByAge,
	PINNED_LABEL,
} from "@/features/source-control/history/age-groups";
import type { Resolution } from "@/features/sync";

const NOW = new Date(2026, 9, 28, 15, 0).getTime();
const MINUTE = 60_000;
const DAY = 86_400_000;

function row(
	id: string,
	at: number,
	res: Resolution | null = "push",
	pinned = false,
): Aged & { id: string } {
	return { id, at, res, pinned };
}

function shape(rows: Array<Aged & { id: string }>) {
	return groupByAge(rows, NOW).map(({ label, chip, rows }) => ({
		label,
		chip,
		ids: rows.map((row) => row.id),
	}));
}

describe("groupByAge", () => {
	it("leads with pins, then the last hour of single pushes, then days", () => {
		expect(
			shape([
				row("a", NOW - 5 * MINUTE),
				row("p", NOW - 30 * MINUTE, "push", true),
				row("b", NOW - 59 * MINUTE),
				row("c", NOW - 61 * MINUTE),
				row("d", NOW - 3 * 60 * MINUTE, "10m"),
				row("e", NOW - DAY, "1h"),
			]),
		).toEqual([
			{ label: PINNED_LABEL, chip: null, ids: ["p"] },
			{ label: "Last hour", chip: "push", ids: ["a", "b"] },
			{ label: "Today", chip: "10m", ids: ["c", "d"] },
			{ label: "Yesterday", chip: "1h", ids: ["e"] },
		]);
	});

	it("names a chip only where the resolution changes", () => {
		const groups = shape([
			row("a", NOW - 2 * DAY, "1h"),
			row("b", NOW - 3 * DAY, "1h"),
		]);
		expect(groups.map((group) => group.chip)).toEqual(["1h", null]);
	});

	it("groups daily versions by week and weekly ones by month", () => {
		const daily = new Date(2026, 9, 14, 12).getTime();
		const weekly = new Date(2026, 8, 9, 12).getTime();
		const groups = shape([
			row("a", daily, "1d"),
			row("b", daily - DAY, "1d"),
			row("c", weekly, "1w"),
			row("d", weekly - 7 * DAY, "1w"),
		]);
		const range = new Intl.DateTimeFormat(undefined, {
			month: "short",
			day: "numeric",
		}).formatRange(new Date(2026, 9, 12), new Date(2026, 9, 18));
		expect(groups).toEqual([
			{ label: range, chip: "1d", ids: ["a", "b"] },
			{
				label: new Date(weekly).toLocaleDateString(undefined, {
					month: "long",
					year: "numeric",
				}),
				chip: "1w",
				ids: ["c", "d"],
			},
		]);
	});

	it("keeps a version off the walk with single pushes", () => {
		expect(shape([row("a", NOW - MINUTE, null)])).toEqual([
			{ label: "Last hour", chip: "push", ids: ["a"] },
		]);
	});
});

describe("ageTitle", () => {
	it("says the time, the day or the week the version stands for", () => {
		const at = new Date(2026, 8, 9, 14, 41).getTime();
		expect(ageTitle({ at, res: "1h" }, NOW)).toBe(
			new Date(at).toLocaleTimeString(undefined, {
				hour: "2-digit",
				minute: "2-digit",
			}),
		);
		expect(ageTitle({ at, res: "1d" }, NOW)).toBe(
			new Date(at).toLocaleDateString(undefined, {
				weekday: "short",
				day: "numeric",
				month: "short",
			}),
		);
		expect(ageTitle({ at, res: "1w" }, NOW)).toBe(
			`Week of ${new Date(2026, 8, 7).toLocaleDateString(undefined, {
				day: "numeric",
				month: "short",
			})}`,
		);
	});
});
