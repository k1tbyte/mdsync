import { Text } from "@codemirror/state";

import {
	commonEnds,
	computeHunks,
	type HunkSegment,
	hunkSegments,
	type SyncHunk,
} from "@/sync/hunks";

/** One change a gutter mark stands for: a segment of a sync hunk, the unit push and revert act on. */
export interface SyncChange {
	hunk: SyncHunk;
	segment: HunkSegment;
}

/** The lines a change's mark runs down (1-based) and what it stands for. */
export interface ChangeMark {
	from: number;
	to: number;
	/** `delete` marks the line above removed lines, `topdelete` the line below: the first when they led the note. */
	kind: "add" | "change" | "delete" | "topdelete";
	/** A change that removed more lines than it added: its last line marks the rest. */
	removesBelow: boolean;
}

export interface MarkedChange {
	change: SyncChange;
	mark: ChangeMark;
}

export function presentSyncChange({ hunk, segment }: SyncChange): {
	removedLines: string[];
	addedLines: string[];
} {
	const removedLines: string[] = [];
	const addedLines: string[] = [];
	for (const line of hunk.lines.slice(segment.from, segment.to)) {
		if (line.startsWith("-")) removedLines.push(line.slice(1));
		else if (line.startsWith("+")) addedLines.push(line.slice(1));
	}
	return { removedLines, addedLines };
}

export function hunkTitle(removedCount: number, addedCount: number): string {
	if (addedCount > 0 && removedCount > 0) return "Changes since last sync";
	if (addedCount > 0) return "Added since last sync";
	return "Removed since last sync";
}

/**
 * Every change between the texts with its mark, from the hunks a push or revert recomputes: a mark shows
 * exactly what they would move.
 */
export function markedChanges(baseline: Text, current: Text): MarkedChange[] {
	const { hunks } = computeHunks(baseline.toString(), current.toString());
	const marked: MarkedChange[] = [];
	for (const hunk of hunks) {
		for (const segment of hunkSegments(hunk)) {
			const change = { hunk, segment };
			let mark = changeMark(change);
			const above = marked.at(-1)?.mark;
			// The line above holds another mark: the same gap, marked from below.
			if (mark.kind === "delete" && above && above.to >= mark.from) {
				const below = mark.from + 1;
				mark = {
					from: below,
					to: below,
					kind: "topdelete",
					removesBelow: false,
				};
			}
			marked.push({ change, mark });
		}
	}
	return marked;
}

/** A change's lines here, less those that differ only by the note's final newline. */
export function changeMark(change: SyncChange): ChangeMark {
	const { removedLines, addedLines } = presentSyncChange(change);
	const { head, tail } = commonEnds(removedLines, addedLines);
	const removed = removedLines.slice(head, removedLines.length - tail);
	const added = addedLines.length - head - tail;
	const [start, end] = change.segment.right;
	if (removed.length === 0 && added === 0) {
		// Only the final newline differs: the empty last line it opened, or the line it closed.
		return closesNote(change)
			? { from: end, to: end, kind: "delete", removesBelow: false }
			: { from: end + 1, to: end + 1, kind: "add", removesBelow: false };
	}
	if (added === 0) {
		const after = start + head;
		return after < 1
			? { from: 1, to: 1, kind: "topdelete", removesBelow: false }
			: { from: after, to: after, kind: "delete", removesBelow: false };
	}
	// Text written into blank lines reads as an add.
	const changed = removed.some((line) => line.length > 0);
	return {
		from: start + head + 1,
		to: end - tail,
		kind: changed ? "change" : "add",
		removesBelow: changed && removed.length > added,
	};
}

/** The new side lost the final newline: jsdiff marks the line without one. */
function closesNote({ hunk, segment }: SyncChange): boolean {
	const lines = hunk.lines.slice(segment.from, segment.to + 1);
	return lines.some(
		(line, i) => line.startsWith("\\") && !!lines[i - 1]?.startsWith("+"),
	);
}

export function findChangeForLine(
	changes: readonly MarkedChange[],
	line: number,
): MarkedChange | null {
	return (
		changes.find(({ mark }) => line >= mark.from && line <= mark.to) ?? null
	);
}

/** Where a mark stands, for the popup: "Lines 3-4", "After line 12". */
export function markPlace(mark: ChangeMark): string {
	if (mark.kind === "topdelete")
		return mark.from === 1 ? "Start of file" : `After line ${mark.from - 1}`;
	if (mark.kind === "delete") return `After line ${mark.from}`;
	return mark.to > mark.from
		? `Lines ${mark.from}-${mark.to}`
		: `Line ${mark.from}`;
}

/** Keeps the empty last line a trailing newline implies, so the baseline shows no phantom "added line" at the end. */
export function toCmText(raw: string): Text {
	return Text.of(raw.replace(/\r\n?/g, "\n").split("\n"));
}

export function shouldRedeliverBaseline(
	prev: Text | null,
	next: Text | null,
	hasCachedBaseline: boolean,
): boolean {
	if (next !== null) return false;
	return prev !== null || hasCachedBaseline;
}
