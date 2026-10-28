import { formatDay, pluralize, startOfDay, startOfWeek } from "@/core/shared";
import { RESOLUTIONS } from "../../history/model/periods";
import type { Activity, Resolution } from "../../history/model/types";
import type { Dating } from "../../history/types";

const HOUR_MS = 3_600_000;
/** Upper bounds of pushes per day for levels 1-3; more is level 4. */
const LEVELS = [5, 12, 24];

export const RESOLUTION_TEXT: Record<Resolution, string> = {
	push: "every push",
	"10m": "1 per 10 min",
	"1h": "1 per hour",
	"1d": "1 per day",
	"1w": "1 per week",
	counts: "counts only",
};

export interface CalendarDay {
	start: number;
	pushes: number;
	/** 0 for none, 4 for the busiest. */
	level: number;
	/** The coarsest a version covering it is kept at, `counts` past the oldest one; null when none covers it. */
	res: Resolution | null;
}

export interface CalendarWeek {
	/** From Monday, up to today. */
	days: CalendarDay[];
	/** Short month name on the week a month starts in. */
	month: string | null;
	/** Its newest kept day's, else the newer week's: a week without a version keeps what surrounds it. */
	res: Resolution | null;
}

export interface ActivityCalendar {
	weeks: CalendarWeek[];
	pushes: number;
	since: number;
}

/** Pushes per local day over `weekCount` weeks to today, with how finely history keeps each day. */
export function buildCalendar(
	activity: Activity,
	versions: readonly Dating[],
	weekCount: number,
	now: number = Date.now(),
): ActivityCalendar {
	const perDay = new Map<number, number>();
	for (const [hour, [pushes]] of Object.entries(activity)) {
		const day = startOfDay(Number(hour) * HOUR_MS);
		perDay.set(day, (perDay.get(day) ?? 0) + pushes);
	}
	const walked = versions.filter((version) => version.res !== null);
	const cut = walked.reduce(
		(oldest, version) => Math.min(oldest, version.firstAt),
		Number.POSITIVE_INFINITY,
	);
	const monday = new Date(startOfWeek(now));
	// Built from the date, never by adding hours: a DST switch can skip a midnight.
	const dayStart = (offset: number): number =>
		new Date(
			monday.getFullYear(),
			monday.getMonth(),
			monday.getDate() + offset - 7 * (weekCount - 1),
		).getTime();
	const weeks: CalendarWeek[] = [];
	let pushes = 0;
	for (let week = 0; week < weekCount; week++) {
		const days: CalendarDay[] = [];
		for (let index = 0; index < 7; index++) {
			const start = dayStart(week * 7 + index);
			if (start > now) break;
			const count = perDay.get(start) ?? 0;
			pushes += count;
			days.push({
				start,
				pushes: count,
				level: levelOf(count),
				res: dayRes(start, dayStart(week * 7 + index + 1), walked, cut),
			});
		}
		const opens = new Date(days[0]?.start ?? 0);
		const previous = weeks[weeks.length - 1]?.days[0]?.start;
		const starts =
			previous === undefined
				? opens.getDate() <= 7
				: new Date(previous).getMonth() !== opens.getMonth();
		weeks.push({
			days,
			month: starts
				? opens.toLocaleDateString(undefined, { month: "short" })
				: null,
			res: [...days].reverse().find((day) => day.res)?.res ?? null,
		});
	}
	for (let index = weeks.length - 2; index >= 0; index--) {
		const week = weeks[index] as CalendarWeek;
		week.res ??= weeks[index + 1]?.res ?? null;
	}
	return { weeks, pushes, since: dayStart(0) };
}

/** Runs of weeks kept alike, oldest first, for the strip under the calendar. */
export function bandsOf(
	weeks: readonly CalendarWeek[],
): Array<{ res: Resolution | null; weeks: number }> {
	const bands: Array<{ res: Resolution | null; weeks: number }> = [];
	for (const { res } of weeks) {
		const last = bands[bands.length - 1];
		if (last && last.res === res) last.weeks++;
		else bands.push({ res, weeks: 1 });
	}
	return bands;
}

/** "Wed 14 Oct: 21 pushes · versions 1 per day". */
export function dayTooltip(day: CalendarDay, now: number = Date.now()): string {
	const date = formatDay(day.start, now);
	if (day.pushes === 0) return `${date}: no pushes`;
	const count = `${date}: ${pluralize(day.pushes, "push", "pushes")}`;
	if (day.res === null) return count;
	return day.res === "counts"
		? `${count} · only counts kept`
		: `${count} · versions ${RESOLUTION_TEXT[day.res]}`;
}

function levelOf(pushes: number): number {
	if (pushes === 0) return 0;
	const index = LEVELS.findIndex((bound) => pushes <= bound);
	return index === -1 ? LEVELS.length + 1 : index + 1;
}

function dayRes(
	start: number,
	end: number,
	walked: readonly Dating[],
	cut: number,
): Resolution | null {
	const covering = walked
		.filter((version) => version.firstAt < end && version.at >= start)
		.map((version) => version.res);
	return coarsest(covering) ?? (end <= cut ? "counts" : null);
}

function coarsest(
	resolutions: ReadonlyArray<Resolution | null>,
): Resolution | null {
	let found: Resolution | null = null;
	for (const res of resolutions) {
		if (
			res &&
			(!found || RESOLUTIONS.indexOf(res) > RESOLUTIONS.indexOf(found))
		)
			found = res;
	}
	return found;
}
