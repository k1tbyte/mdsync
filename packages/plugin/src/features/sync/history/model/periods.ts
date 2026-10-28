import type { Resolution } from "./types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** 1970-01-05 was a Monday, where ISO weeks start. */
const MONDAY = 4 * DAY;

interface Span {
	size: number;
	offset: number;
}

interface Rung {
	/** One merged record per span; null keeps every record. */
	keep: Span | null;
	/** What one object holds. */
	group: Span;
	/** How long past its end a group waits before it is built. */
	settle: number | "horizon";
}

const every = (size: number): Span => ({ size, offset: 0 });
const weeks = (count: number): Span => ({ size: count * WEEK, offset: MONDAY });

/** Groups nest (slot < hour < day < week < 4 weeks), so an object is built from finer ones inside it. */
const RUNGS: Record<Resolution, Rung> = {
	push: { keep: null, group: every(10 * MINUTE), settle: 10 * MINUTE },
	"10m": { keep: every(10 * MINUTE), group: every(HOUR), settle: HOUR },
	"1h": { keep: every(HOUR), group: every(DAY), settle: DAY },
	"1d": { keep: every(DAY), group: weeks(1), settle: WEEK },
	"1w": { keep: weeks(1), group: weeks(4), settle: 30 * DAY },
	counts: { keep: null, group: weeks(4), settle: "horizon" },
};

export const RESOLUTIONS: readonly Resolution[] = [
	"push",
	"10m",
	"1h",
	"1d",
	"1w",
	"counts",
];

function floorTo(at: number, span: Span): number {
	return Math.floor((at - span.offset) / span.size) * span.size + span.offset;
}

export function hourOf(at: number): number {
	return Math.floor(at / HOUR);
}

export function groupStart(res: Resolution, at: number): number {
	return floorTo(at, RUNGS[res].group);
}

export function groupEnd(res: Resolution, start: number): number {
	return start + RUNGS[res].group.size;
}

/** The span `at` merges into at this resolution; null when every record stays its own. */
export function keepStart(res: Resolution, at: number): number | null {
	const keep = RUNGS[res].keep;
	return keep ? floorTo(at, keep) : null;
}

/** How much time one kept version stands for; null while every push stays. */
export function keepSize(res: Resolution): number | null {
	return RUNGS[res].keep?.size ?? null;
}

/** `horizon` in ms, null to keep forever. */
export function isDue(
	res: Resolution,
	start: number,
	now: number,
	horizon: number | null,
): boolean {
	const settle = RUNGS[res].settle;
	if (settle === "horizon" && horizon === null) return false;
	const wait = settle === "horizon" ? (horizon ?? 0) : settle;
	return groupEnd(res, start) + wait <= now;
}

/** When a record dated `at` may go to counts: retention keeps its versions at least until then. */
export function keptUntil(at: number, horizon: number | null): number | null {
	return horizon === null
		? null
		: groupEnd("counts", groupStart("counts", at)) + horizon;
}

/** Records before this are past `keptUntil`: once GC runs, only counts and pins hold them. */
export function countsBefore(now: number, horizon: number): number {
	return groupStart("counts", now - horizon);
}

/** The coarsest resolution whose group around `at` is due; null while it is too fresh to pack. */
export function dueResolution(
	at: number,
	now: number,
	horizon: number | null,
): Resolution | null {
	for (let index = RESOLUTIONS.length - 1; index >= 0; index--) {
		const res = RESOLUTIONS[index] as Resolution;
		if (isDue(res, groupStart(res, at), now, horizon)) return res;
	}
	return null;
}
