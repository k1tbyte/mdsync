import type { Chunk } from "@codemirror/merge";
import { Text } from "@codemirror/state";

import {
	computeHunks,
	type HunkSegment,
	hunkSegments,
	type SyncHunk,
} from "@/sync/hunks";

export interface PresentedChunk {
	removedLines: string[];
	addedLines: string[];
	addedFromLine: number | null;
	addedToLine: number | null;
	/** The line removed lines follow; 0 when they led the note. */
	removedAfter: number;
}

/** One change a gutter mark stands for: a segment of a sync hunk, the unit push and revert act on. */
export interface SyncChange {
	hunk: SyncHunk;
	segment: HunkSegment;
}

export function presentSyncChange({
	hunk,
	segment,
}: SyncChange): Pick<PresentedChunk, "removedLines" | "addedLines"> {
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

/** The lines a chunk's mark runs down (1-based) and what it stands for. */
export interface ChunkMark {
	from: number;
	to: number;
	/** `delete` marks the line above removed lines, `topdelete` the first line when they led the note. */
	kind: "add" | "change" | "delete" | "topdelete";
	/** A change that removed more lines than it added: its last line marks the rest. */
	removesBelow: boolean;
}

export function chunkMark(
	chunk: Chunk,
	baseline: Text,
	current: Text,
): ChunkMark | null {
	const shown = presentChunk(chunk, baseline, current);
	const removed = shown.removedLines.length;
	const added = shown.addedLines.length;
	if (removed === 0 && added === 0) return null;
	if (added === 0) {
		const after = shown.removedAfter;
		return after < 1
			? { from: 1, to: 1, kind: "topdelete", removesBelow: false }
			: { from: after, to: after, kind: "delete", removesBelow: false };
	}
	const from = shown.addedFromLine ?? 1;
	return {
		from,
		to: shown.addedToLine ?? from,
		kind: removed === 0 ? "add" : "change",
		removesBelow: removed > added,
	};
}

/** Where a mark stands, for the popup: "Lines 3-4", "After line 12". */
export function markPlace(mark: ChunkMark): string {
	if (mark.kind === "topdelete") return "Start of file";
	if (mark.kind === "delete") return `After line ${mark.from}`;
	return mark.to > mark.from
		? `Lines ${mark.from}-${mark.to}`
		: `Line ${mark.from}`;
}

export function findChunkForLine(
	chunks: readonly Chunk[],
	baseline: Text,
	current: Text,
	lineNumber: number,
): { chunk: Chunk; mark: ChunkMark } | null {
	for (const chunk of chunks) {
		const mark = chunkMark(chunk, baseline, current);
		if (mark && lineNumber >= mark.from && lineNumber <= mark.to)
			return { chunk, mark };
	}
	return null;
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

export function presentChunk(
	chunk: Chunk,
	baseline: Text,
	current: Text,
): PresentedChunk {
	const removed = sliceChunkLines(baseline, chunk.fromA, chunk.toA);
	const added = sliceChunkLines(current, chunk.fromB, chunk.toB);
	const commonPrefix = commonPrefixCount(removed.lines, added.lines);
	const commonSuffix = commonSuffixCount(
		removed.lines,
		added.lines,
		commonPrefix,
	);
	let removedLines = removed.lines.slice(
		commonPrefix,
		removed.lines.length - commonSuffix,
	);
	const addedLines = added.lines.slice(
		commonPrefix,
		added.lines.length - commonSuffix,
	);
	if (
		addedLines.length > 0 &&
		removedLines.every((line) => line.length === 0)
	) {
		removedLines = [];
	}
	const addedFromLine =
		addedLines.length > 0 && added.fromLine !== null
			? clampLine(added.fromLine + commonPrefix, current.lines)
			: null;
	const addedToLine =
		addedFromLine === null ? null : addedFromLine + addedLines.length - 1;
	const at = clampPos(chunk.fromB, current);
	const start = current.lineAt(at);
	// A chunk starts mid-line only at the end of a note without a final newline: the gap follows that line.
	const removedAfter =
		start.number - (start.from === at ? 1 : 0) + commonPrefix;
	return {
		removedLines,
		addedLines,
		addedFromLine,
		addedToLine,
		removedAfter,
	};
}

/**
 * The sync change a gutter line belongs to. A hunk's context swallows nearby edits, so the popup, push and
 * revert all take the segment: what the popup shows is all that moves.
 */
export function findSyncChangeForLine(
	lineNumber: number,
	baseline: Text,
	current: Text,
): SyncChange | null {
	const { hunks } = computeHunks(
		baseline.sliceString(0, baseline.length),
		current.sliceString(0, current.length),
	);
	for (const hunk of hunks) {
		for (const segment of hunkSegments(hunk)) {
			const [from, to] = segment.right;
			// A removal has no lines here: its mark sits on the line after the gap, or before it at the end.
			const first = from === to ? Math.max(1, from) : from + 1;
			const last = Math.max(to, from + 1);
			if (lineNumber >= first && lineNumber <= last) return { hunk, segment };
		}
	}
	return null;
}

function sliceChunkLines(
	text: Text,
	from: number,
	to: number,
): { lines: string[]; fromLine: number | null } {
	if (from === to) return { lines: [], fromLine: null };
	const safeFrom = clampPos(from, text);
	const safeTo = clampPos(to, text);
	const raw = text.sliceString(safeFrom, safeTo);
	const trimmed = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
	return {
		lines: trimmed.split("\n"),
		fromLine: text.lineAt(safeFrom).number,
	};
}

function commonPrefixCount(left: string[], right: string[]): number {
	let count = 0;
	const max = Math.min(left.length, right.length);
	while (count < max && left[count] === right[count]) {
		count += 1;
	}
	return count;
}

function commonSuffixCount(
	left: string[],
	right: string[],
	prefixCount: number,
): number {
	let count = 0;
	const max = Math.min(left.length, right.length) - prefixCount;
	while (
		count < max &&
		left[left.length - 1 - count] === right[right.length - 1 - count]
	) {
		count += 1;
	}
	return count;
}

export function clampPos(pos: number, text: Text): number {
	if (pos < 0) return 0;
	if (pos > text.length) return text.length;
	return pos;
}

function clampLine(line: number, lastLine: number): number {
	if (line < 1) return 1;
	if (line > lastLine) return lastLine;
	return line;
}
