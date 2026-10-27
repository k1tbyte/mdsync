import { changedMiddle, type DiffRange, diffRanges, toLf } from "@/core/utils";

export const EHunkKind = {
	Added: "added",
	Removed: "removed",
	Modified: "modified",
} as const;
export type EHunkKind = (typeof EHunkKind)[keyof typeof EHunkKind];

export interface SyncHunk {
	index: number;
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: string[];
	added: number;
	removed: number;
	kind: EHunkKind;
}

export interface ComputedHunks {
	hunks: SyncHunk[];
	leftLines: string[];
	rightLines: string[];
}

/** 0-based, half-open line range in one side. */
export type LineRange = readonly [number, number];

/**
 * One run of changed lines inside a hunk: the smallest unit a user can take or leave. Segment `k` of hunk `h`
 * is stable while the texts are.
 */
export interface HunkSegment {
	hunk: number;
	index: number;
	/** Offsets into `hunk.lines`, half-open. */
	from: number;
	to: number;
	left: LineRange;
	right: LineRange;
	removed: number;
	added: number;
}

/** Hunk index -> the segments of that hunk to take from the right side. */
export type HunkSelection = ReadonlyMap<number, ReadonlySet<number>>;

export function hunkSegments(hunk: SyncHunk): HunkSegment[] {
	const segments: HunkSegment[] = [];
	let left = Math.max(1, hunk.oldStart) - 1;
	let right = Math.max(1, hunk.newStart) - 1;
	let open: HunkSegment | null = null;
	for (const [offset, line] of hunk.lines.entries()) {
		const prefix = line[0];
		if (prefix === " ") {
			if (open) segments.push(open);
			open = null;
			left++;
			right++;
			continue;
		}
		// A "\ No newline at end of file" marker neither opens nor closes a run.
		if (prefix !== "-" && prefix !== "+") continue;
		if (!open) {
			open = {
				hunk: hunk.index,
				index: segments.length,
				from: offset,
				to: offset,
				left: [left, left],
				right: [right, right],
				removed: 0,
				added: 0,
			};
		}
		if (prefix === "-") {
			open.removed++;
			left++;
		} else {
			open.added++;
			right++;
		}
		open.to = offset + 1;
		open.left = [open.left[0], left];
		open.right = [open.right[0], right];
	}
	if (open) segments.push(open);
	return segments;
}

/** Every segment of each given hunk. */
export function wholeHunks(hunks: Iterable<SyncHunk>): HunkSelection {
	const selection = new Map<number, Set<number>>();
	for (const hunk of hunks) {
		selection.set(hunk.index, new Set(hunkSegments(hunk).map((s) => s.index)));
	}
	return selection;
}

/** Every segment not in `selection`. */
export function complementSelection(
	hunks: readonly SyncHunk[],
	selection: HunkSelection,
): HunkSelection {
	const complement = new Map<number, Set<number>>();
	for (const hunk of hunks) {
		const taken = selection.get(hunk.index);
		const rest = new Set(
			hunkSegments(hunk)
				.map((s) => s.index)
				.filter((index) => !taken?.has(index)),
		);
		if (rest.size > 0) complement.set(hunk.index, rest);
	}
	return complement;
}

export function isFullSelection(
	hunks: readonly SyncHunk[],
	selection: HunkSelection,
): boolean {
	return hunks.every((hunk) =>
		hunkSegments(hunk).every((s) => selection.get(hunk.index)?.has(s.index)),
	);
}

export function selectionSize(selection: HunkSelection): number {
	let size = 0;
	for (const segments of selection.values()) size += segments.size;
	return size;
}

type RawHunk = Pick<
	SyncHunk,
	"oldStart" | "oldLines" | "newStart" | "newLines" | "lines"
>;

const CONTEXT_LINES = 3;
/** Compares before a diff gives up (~35 ms on desktop); past it the differing middle is one block. */
export const DIFF_BUDGET = 2_000_000;
const NO_NEWLINE_MARKER = "\\ No newline at end of file";

export function computeHunks(left: string, right: string): ComputedHunks {
	const normalizedLeft = toLf(left);
	const normalizedRight = toLf(right);
	const hunks: SyncHunk[] = diffHunks(normalizedLeft, normalizedRight).map(
		(h, idx) =>
			annotateHunk(
				idx,
				h.oldStart,
				h.oldLines,
				h.newStart,
				h.newLines,
				h.lines,
			),
	);
	// Split on demand: the editor's signs never read them, and recompute on every keystroke.
	let leftLines: string[] | undefined;
	let rightLines: string[] | undefined;
	return {
		hunks,
		get leftLines() {
			leftLines ??= splitLines(normalizedLeft);
			return leftLines;
		},
		get rightLines() {
			rightLines ??= splitLines(normalizedRight);
			return rightLines;
		},
	};
}

/**
 * Diffs from the first differing line less its context: the differ matches a common prefix before anything
 * else, so the hunks are those of the whole texts, shifted. Not a common suffix: repeated lines align differently.
 */
function diffHunks(left: string, right: string): RawHunk[] {
	if (left === right) return [];
	const from = linesBefore(left, commonPrefix(left, right), CONTEXT_LINES);
	const a = lineTokens(left.slice(from));
	const b = lineTokens(right.slice(from));
	// A budget, unlike a timeout, is deterministic: an operation recomputing
	// these hunks from the same texts gets the same indices the view drew.
	const ranges = diffRanges(a, b, DIFF_BUDGET) ?? [changedMiddle(a, b)];
	return contextHunks(a, b, ranges, newlinesBefore(left, from));
}

/** As a unified diff: ranges at most twice the context apart share a hunk. */
function contextHunks(
	a: readonly string[],
	b: readonly string[],
	ranges: readonly DiffRange[],
	skipped: number,
): RawHunk[] {
	const hunks: RawHunk[] = [];
	for (let first = 0; first < ranges.length; ) {
		let last = first;
		while (
			last + 1 < ranges.length &&
			(ranges[last + 1] as DiffRange).a[0] - (ranges[last] as DiffRange).a[1] <=
				2 * CONTEXT_LINES
		) {
			last++;
		}
		const { a: aFirst, b: bFirst } = ranges[first] as DiffRange;
		const { a: aLast, b: bLast } = ranges[last] as DiffRange;
		const aStart = Math.max(0, aFirst[0] - CONTEXT_LINES);
		const aEnd = Math.min(a.length, aLast[1] + CONTEXT_LINES);
		const bStart = bFirst[0] - (aFirst[0] - aStart);
		const bEnd = bLast[1] + (aEnd - aLast[1]);
		const lines: string[] = [];
		let at = aStart;
		for (const range of ranges.slice(first, last + 1)) {
			pushLines(lines, " ", a, at, range.a[0]);
			pushLines(lines, "-", a, ...range.a);
			pushLines(lines, "+", b, ...range.b);
			at = range.a[1];
		}
		pushLines(lines, " ", a, at, aEnd);
		hunks.push({
			oldStart: aStart + 1 + skipped,
			oldLines: aEnd - aStart,
			newStart: bStart + 1 + skipped,
			newLines: bEnd - bStart,
			lines,
		});
		first = last + 1;
	}
	return hunks;
}

/** Binary search over native compares: a loop over characters costs as much as the diff it spares. */
function commonPrefix(a: string, b: string): number {
	let low = 0;
	let high = Math.min(a.length, b.length);
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if (a.slice(0, mid) === b.slice(0, mid)) low = mid;
		else high = mid - 1;
	}
	return low;
}

/** Start of the line holding `at`, then `lines` lines further up. */
function linesBefore(text: string, at: number, lines: number): number {
	const newlineBefore = (pos: number) =>
		pos < 0 ? -1 : text.lastIndexOf("\n", pos);
	let cut = newlineBefore(at - 1);
	for (let k = 0; k < lines && cut >= 0; k++) cut = newlineBefore(cut - 1);
	return cut + 1;
}

function newlinesBefore(text: string, end: number): number {
	let count = 0;
	for (
		let at = text.indexOf("\n");
		at >= 0 && at < end;
		at = text.indexOf("\n", at + 1)
	)
		count++;
	return count;
}

/** Left text with the selected segments replaced by their right side. */
export function applyHunks(
	left: string,
	hunks: readonly SyncHunk[],
	selected: HunkSelection,
): string {
	// A line's terminator belongs to its selected side, including EOF newline changes.
	const baseLines = lineTokens(toLf(left));
	const out: string[] = [];
	let cursor = 0;
	for (const hunk of hunks) {
		const startIndex = Math.max(0, hunk.oldStart - 1);
		while (cursor < startIndex && cursor < baseLines.length) {
			out.push(baseLines[cursor] as string);
			cursor++;
		}
		const taken = selected.get(hunk.index);
		let segment = -1;
		let inSegment = false;
		for (const [offset, line] of hunk.lines.entries()) {
			const prefix = line[0];
			if (prefix !== " " && prefix !== "-" && prefix !== "+") continue;
			if (prefix === " ") {
				inSegment = false;
			} else if (!inSegment) {
				inSegment = true;
				segment++;
			}
			const keep = taken?.has(segment) ? "+" : "-";
			if (prefix === " " || prefix === keep) {
				const ending = hunk.lines[offset + 1]?.startsWith("\\") ? "" : "\n";
				out.push(line.slice(1) + ending);
			}
		}
		cursor = startIndex + hunk.oldLines;
	}
	while (cursor < baseLines.length) {
		out.push(baseLines[cursor] as string);
		cursor++;
	}
	return out.join("");
}

/** One push per line: spreading a note-sized block into `push` overflows the stack. */
function pushLines(
	out: string[],
	prefix: string,
	tokens: readonly string[],
	from: number,
	to: number,
): void {
	for (let i = from; i < to; i++) {
		const token = tokens[i] as string;
		if (token.endsWith("\n")) out.push(prefix + token.slice(0, -1));
		else out.push(prefix + token, NO_NEWLINE_MARKER);
	}
}

/** Lines with their terminators, so a missing final newline differs like any other text. */
function lineTokens(text: string): string[] {
	return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function annotateHunk(
	index: number,
	oldStart: number,
	oldLines: number,
	newStart: number,
	newLines: number,
	lines: string[],
): SyncHunk {
	let added = 0;
	let removed = 0;
	for (const line of lines) {
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return {
		index,
		oldStart,
		oldLines,
		newStart,
		newLines,
		lines,
		added,
		removed,
		kind: classify(added, removed),
	};
}

function classify(added: number, removed: number): EHunkKind {
	if (added > 0 && removed === 0) return EHunkKind.Added;
	if (added === 0 && removed > 0) return EHunkKind.Removed;
	return EHunkKind.Modified;
}

function splitLines(value: string): string[] {
	if (value === "") return [];
	return value.split("\n");
}
