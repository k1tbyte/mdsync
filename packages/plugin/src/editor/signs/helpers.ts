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
	deletionLine: number;
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

export function findChunkForLine(
	chunks: readonly Chunk[],
	current: Text,
	lineNumber: number,
): Chunk | null {
	for (const chunk of chunks) {
		if (chunk.fromB === chunk.toB) {
			const at = current.lineAt(clampPos(chunk.fromB, current)).number;
			if (at === lineNumber) return chunk;
			continue;
		}
		const from = current.lineAt(chunk.fromB).number;
		const to = current.lineAt(clampPos(chunk.endB, current)).number;
		if (lineNumber >= from && lineNumber <= to) return chunk;
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
	const deletionLine = clampLine(
		current.lineAt(clampPos(chunk.fromB, current)).number + commonPrefix,
		current.lines,
	);
	return {
		removedLines,
		addedLines,
		addedFromLine,
		addedToLine,
		deletionLine,
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
