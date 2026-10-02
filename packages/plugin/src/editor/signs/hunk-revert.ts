import type { Chunk } from "@codemirror/merge";
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import type { HunkSegment } from "@/sync/hunks";

import { clampPos, type SyncChange } from "./helpers";

export interface TextChange {
	from: number;
	to: number;
	insert: string;
}

/** Whole lines out of the baseline; a line's terminator goes with it, so EOF newline changes revert too. */
export function segmentRevert(
	current: Text,
	baseline: Text,
	{ left, right }: HunkSegment,
): TextChange {
	return {
		from: lineStart(current, right[0] + 1),
		to: lineStart(current, right[1] + 1),
		insert: baseline.sliceString(
			lineStart(baseline, left[0] + 1),
			lineStart(baseline, left[1] + 1),
		),
	};
}

export function chunkRevert(
	current: Text,
	baseline: Text,
	chunk: Chunk,
): TextChange {
	return {
		from: clampPos(chunk.fromB, current),
		to: clampPos(chunk.toB, current),
		insert: baseline.sliceString(
			clampPos(chunk.fromA, baseline),
			clampPos(chunk.toA, baseline),
		),
	};
}

export function revertHunk(
	view: EditorView,
	baseline: Text,
	chunk: Chunk,
	syncChange: SyncChange | null,
): void {
	const { doc } = view.state;
	view.dispatch({
		changes: syncChange
			? segmentRevert(doc, baseline, syncChange.segment)
			: chunkRevert(doc, baseline, chunk),
	});
}

function lineStart(text: Text, line: number): number {
	if (line < 1) return 0;
	if (line > text.lines) return text.length;
	return text.line(line).from;
}
