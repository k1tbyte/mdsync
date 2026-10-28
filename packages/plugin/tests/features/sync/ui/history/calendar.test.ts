import { afterEach, describe, expect, it } from "vitest";
import type { Activity, Dating, Resolution } from "@/features/sync";
import {
	bandsOf,
	buildCalendar,
	type CalendarDay,
	dayTooltip,
} from "@/features/sync/ui/history/calendar";

// Wednesday.
const NOW = new Date(2026, 9, 28, 15, 0).getTime();
const HOUR = 3_600_000;

function local(month: number, day: number, hour = 12): number {
	return new Date(2026, month, day, hour).getTime();
}

function activity(...pushes: Array<[number, number]>): Activity {
	const result: Activity = {};
	for (const [at, count] of pushes) {
		const hour = Math.floor(at / HOUR);
		result[hour] = [(result[hour]?.[0] ?? 0) + count, count];
	}
	return result;
}

function dated(at: number, res: Resolution | null, firstAt = at): Dating {
	return { at, firstAt, pushes: 1, res };
}

function dayOf(calendar: ReturnType<typeof buildCalendar>, start: number) {
	return calendar.weeks
		.flatMap((week) => week.days)
		.find((day) => day.start === start);
}

describe("buildCalendar", () => {
	it("lays weeks from Monday to today and sums pushes per local day", () => {
		const calendar = buildCalendar(
			activity([local(9, 28, 1), 3], [local(9, 28, 23), 2], [local(9, 26), 30]),
			[dated(local(9, 28), "push")],
			2,
			NOW,
		);
		expect(calendar.since).toBe(new Date(2026, 9, 19).getTime());
		expect(calendar.weeks.map((week) => week.days.length)).toEqual([7, 3]);
		expect(calendar.pushes).toBe(35);
		expect(dayOf(calendar, new Date(2026, 9, 28).getTime())).toMatchObject({
			pushes: 5,
			level: 1,
		});
		expect(dayOf(calendar, new Date(2026, 9, 26).getTime())?.level).toBe(4);
	});

	it("rates days from 0 to 4 at 5, 12 and 24 pushes", () => {
		const days = [0, 5, 6, 12, 13, 24, 25].map((count, index) =>
			index === 0 ? [local(9, 19), 0] : [local(9, 19 + index), count],
		) as Array<[number, number]>;
		const calendar = buildCalendar(activity(...days), [], 2, NOW);
		expect(calendar.weeks[0]?.days.map((day) => day.level)).toEqual([
			0, 1, 2, 2, 3, 3, 4,
		]);
	});

	it("keeps a day at the coarsest version covering it, counts past the oldest", () => {
		const calendar = buildCalendar(
			activity([local(9, 20), 4]),
			[
				dated(local(9, 28), "push"),
				dated(local(9, 27, 18), "10m"),
				dated(local(9, 27, 20), "1h", local(9, 26, 9)),
				dated(local(9, 21), "1d", local(9, 21, 8)),
				dated(local(9, 1), null),
			],
			2,
			NOW,
		);
		const res = calendar.weeks.flatMap((week) =>
			week.days.map((day) => day.res),
		);
		expect(res).toEqual([
			"counts",
			"counts",
			"1d",
			null,
			null,
			null,
			null,
			"1h",
			"1h",
			"push",
		]);
		expect(calendar.weeks.map((week) => week.res)).toEqual(["1d", "push"]);
	});

	it("carries the newer week's resolution over a week no version covers", () => {
		const calendar = buildCalendar(
			{},
			[dated(local(9, 28), "1h"), dated(local(9, 7), "1d")],
			4,
			NOW,
		);
		expect(calendar.weeks.map((week) => week.res)).toEqual([
			"1d",
			"1h",
			"1h",
			"1h",
		]);
		expect(bandsOf(calendar.weeks)).toEqual([
			{ res: "1d", weeks: 1 },
			{ res: "1h", weeks: 3 },
		]);
	});

	it("keeps only counts without a version", () => {
		const calendar = buildCalendar(activity([local(9, 27), 2]), [], 1, NOW);
		expect(calendar.weeks[0]?.days.every((day) => day.res === "counts")).toBe(
			true,
		);
	});

	it("starts a month label on the week its first Monday falls in", () => {
		const calendar = buildCalendar({}, [], 6, NOW);
		expect(calendar.weeks.map((week) => week.month)).toEqual([
			null,
			null,
			new Date(2026, 9, 1).toLocaleDateString(undefined, { month: "short" }),
			null,
			null,
			null,
		]);
	});

	it("counts a DST day once, by its local date", () => {
		// Europe and the US leave summer time on Oct 25 and Nov 1 2026; either way each hour lands on one day.
		const hours = Array.from({ length: 48 }, (_, index): [number, number] => [
			new Date(2026, 9, 24).getTime() + index * HOUR,
			1,
		]);
		const calendar = buildCalendar(activity(...hours), [], 2, NOW);
		const total = calendar.weeks
			.flatMap((week) => week.days)
			.reduce((sum, day) => sum + day.pushes, 0);
		expect(total).toBe(48);
	});
});

describe("buildCalendar across a skipped midnight", () => {
	const zone = process.env.TZ;
	afterEach(() => {
		if (zone === undefined) delete process.env.TZ;
		else process.env.TZ = zone;
	});

	it("keeps each day to its own midnights", () => {
		// Chile skips 2026-09-06 00:00; Monday's first hour is not Sunday's.
		process.env.TZ = "America/Santiago";
		const at = (day: number, hour: number, minute = 0) =>
			new Date(2026, 8, day, hour, minute).getTime();
		const calendar = buildCalendar(
			activity([at(6, 12), 3], [at(1, 12), 2]),
			[dated(at(7, 0, 30), "1h")],
			2,
			at(9, 12),
		);
		const days = calendar.weeks.flatMap((week) => week.days);
		expect(days.every((day) => new Date(day.start).getMinutes() === 0)).toBe(
			true,
		);
		expect(days.find((day) => day.start === at(1, 0))?.pushes).toBe(2);
		const sunday = days.find((day) => new Date(day.start).getDate() === 6);
		expect(sunday).toMatchObject({ pushes: 3, res: "counts" });
		expect(days.find((day) => day.start === at(7, 0))?.res).toBe("1h");
	});
});

describe("buildCalendar on a long walk", () => {
	it("takes any number of versions", () => {
		const versions = Array.from({ length: 200_000 }, (_, index) =>
			dated(local(9, 28) - index, "push"),
		);
		expect(() => buildCalendar({}, versions, 1, NOW)).not.toThrow();
	});
});

describe("dayTooltip", () => {
	const day = (pushes: number, res: Resolution | null): CalendarDay => ({
		start: local(9, 14, 0),
		pushes,
		level: 0,
		res,
	});
	const date = new Date(local(9, 14, 0)).toLocaleDateString(undefined, {
		weekday: "short",
		day: "numeric",
		month: "short",
	});

	it("says the pushes and how the day is kept", () => {
		expect(dayTooltip(day(21, "1d"), NOW)).toBe(
			`${date}: 21 pushes · versions 1 per day`,
		);
		expect(dayTooltip(day(1, "counts"), NOW)).toBe(
			`${date}: 1 push · only counts kept`,
		);
		expect(dayTooltip(day(0, "1d"), NOW)).toBe(`${date}: no pushes`);
	});
});
