import { diffRanges, toLf } from "@/core/utils";

import { anchoredHunks } from "./anchored-hunks";
import { DIFF_BUDGET } from "./hunks";

/** 0-based, half-open line range in one of the original sides. */
export type LineRange = readonly [number, number];
/** Half-open character span in the Result document. */
export interface Span {
	from: number;
	to: number;
}
export type EMergeSide = "local" | "remote";
/** How one side of a change stands: not a change there, still to decide, taken, or dismissed. */
export type ESideStatus = "none" | "open" | "applied" | "ignored";
export type SideStatus = Readonly<Record<EMergeSide, ESideStatus>>;
/** The lines each side has contributed to the Result. */
export type Taken = Partial<Readonly<Record<EMergeSide, Span>>>;

/** One region where a side differs from the base; the IntelliJ "TextMergeChange". */
export interface MergeChange {
	index: number;
	conflict: boolean;
	base: LineRange;
	endsAtEof: boolean;
	local: LineRange;
	remote: LineRange;
	result: Span;
	taken: Taken;
	status: SideStatus;
}

export interface MergeSession {
	text: string;
	changes: MergeChange[];
	baseLines: string[];
	localLines: string[];
	remoteLines: string[];
}

interface MergeRegion {
	base: LineRange;
	local: LineRange;
	remote: LineRange;
	changed: Readonly<Record<EMergeSide, boolean>>;
}

interface SideHunk {
	side: EMergeSide;
	base: LineRange;
	lines: LineRange;
}

export const MERGE_SIDES: readonly EMergeSide[] = ["local", "remote"];

export function isResolved(change: MergeChange): boolean {
	return MERGE_SIDES.every((side) => change.status[side] !== "open");
}

export function countUnresolved(changes: readonly MergeChange[]): number {
	return changes.filter((change) => !isResolved(change)).length;
}

/**
 * Groups both sides' hunks by overlapping-or-touching base lines, as diff3 does; an unchanged side still owns
 * the base-equal lines of the region.
 */
export function threeWayRegions(
	base: string[],
	local: string[],
	remote: string[],
	groupTouching = true,
): MergeRegion[] {
	const hunks = [
		...sideHunks(base, local, "local"),
		...sideHunks(base, remote, "remote"),
	].sort((a, b) => a.base[0] - b.base[0]);
	const regions: MergeRegion[] = [];
	const cursor = { base: 0, local: 0, remote: 0 };
	let i = 0;
	while (i < hunks.length) {
		const group: SideHunk[] = [];
		const start = hunks[i]?.base[0] ?? 0;
		let end = start;
		for (; i < hunks.length; i++) {
			const hunk = hunks[i];
			if (!hunk) break;
			if (group.length > 0 && !joins(hunk, start, end, groupTouching)) break;
			end = Math.max(end, hunk.base[1]);
			group.push(hunk);
		}
		const sideRange = (side: EMergeSide): LineRange => {
			const own = group.filter((hunk) => hunk.side === side);
			if (own.length === 0) {
				const offset = cursor[side] - cursor.base;
				return [start + offset, end + offset];
			}
			// Outside its own hunks a side equals the base, so extra base lines map onto as many side lines.
			const first = own[0] as SideHunk;
			const last = own[own.length - 1] as SideHunk;
			const minBase = first.base[0];
			const maxBase = last.base[1];
			const minLine = first.lines[0];
			const maxLine = last.lines[1];
			return [minLine - (minBase - start), maxLine + (end - maxBase)];
		};
		const region: MergeRegion = {
			base: [start, end],
			local: sideRange("local"),
			remote: sideRange("remote"),
			changed: {
				local: group.some((hunk) => hunk.side === "local"),
				remote: group.some((hunk) => hunk.side === "remote"),
			},
		};
		regions.push(region);
		cursor.base = end;
		cursor.local = region.local[1];
		cursor.remote = region.remote[1];
	}
	return regions;
}

function joins(
	hunk: SideHunk,
	start: number,
	end: number,
	groupTouching: boolean,
): boolean {
	if (hunk.base[0] !== end) return hunk.base[0] < end;
	const insertsAtSamePoint = start === end && hunk.base[1] === end;
	return groupTouching || insertsAtSamePoint;
}

/** Non-conflicting regions start applied with the changed side; a real conflict keeps the base lines until chosen. */
export function buildMergeSession(
	base: string,
	local: string,
	remote: string,
): MergeSession {
	const baseLines = toLines(base);
	const localLines = toLines(local);
	const remoteLines = toLines(remote);
	const out: string[] = [];
	const changes: MergeChange[] = [];
	let length = 0;
	let baseCursor = 0;
	const push = (lines: readonly string[]): void => {
		for (const line of lines) {
			out.push(line);
			length += line.length + 1;
		}
	};
	for (const region of threeWayRegions(baseLines, localLines, remoteLines)) {
		push(baseLines.slice(baseCursor, region.base[0]));
		const ownLocal = localLines.slice(...region.local);
		const ownRemote = remoteLines.slice(...region.remote);
		const conflict =
			region.changed.local &&
			region.changed.remote &&
			!sameLines(ownLocal, ownRemote);
		const from = length;
		if (conflict) push(baseLines.slice(...region.base));
		else push(region.changed.local ? ownLocal : ownRemote);
		const result = { from, to: length };
		const taken: Partial<Record<EMergeSide, Span>> = {};
		const status: Record<EMergeSide, ESideStatus> = {
			local: "none",
			remote: "none",
		};
		for (const side of MERGE_SIDES) {
			if (!region.changed[side]) continue;
			status[side] = conflict ? "open" : "applied";
			if (!conflict) taken[side] = result;
		}
		changes.push({
			index: changes.length,
			conflict,
			base: region.base,
			endsAtEof: region.base[1] === baseLines.length,
			local: region.local,
			remote: region.remote,
			result,
			taken,
			status,
		});
		baseCursor = region.base[1];
	}
	push(baseLines.slice(baseCursor));
	const text = out.join("\n");
	// The running length counts a newline after every line; the last line has none.
	const clamp = (span: Span): Span => ({
		from: Math.min(span.from, text.length),
		to: Math.min(span.to, text.length),
	});
	for (const change of changes) {
		change.result = clamp(change.result);
		for (const side of MERGE_SIDES) {
			if (change.taken[side])
				change.taken = { ...change.taken, [side]: change.result };
		}
	}
	return { text, changes, baseLines, localLines, remoteLines };
}

function sideHunks(
	base: string[],
	lines: string[],
	side: EMergeSide,
): SideHunk[] {
	// Myers with a budget: diff3's own LCS goes quadratic on repeated lines like blanks.
	const ranges =
		diffRanges(base, lines, DIFF_BUDGET) ?? anchoredHunks(base, lines);
	return ranges.map(({ a, b }) => ({ side, base: a, lines: b }));
}

export function sameLines(a: readonly string[], b: readonly string[]): boolean {
	return (
		a === b || (a.length === b.length && a.every((line, i) => line === b[i]))
	);
}

/** Splits text into lines after normalising CRLF to prevent spurious mixed-EOL diffs. */
export function toLines(value: string): string[] {
	return toLf(value).split("\n");
}
