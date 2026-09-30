import type { Chunk } from "@codemirror/merge";
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import type { SyncHunk } from "@/sync/hunks";

import { clampPos } from "./helpers";

export interface TextChange {
	from: number;
	to: number;
	insert: string;
}

export function syncHunkRevert(
	current: Text,
	baseline: Text,
	hunk: SyncHunk,
): TextChange {
	const from = lineStart(current, hunk.newStart);
	const to = lineStart(current, hunk.newStart + hunk.newLines);
	// Trailing context makes a hunk reach both ends or neither: the slice keeps the baseline's EOF as is.
	const insert = baseline.sliceString(
		lineStart(baseline, hunk.oldStart),
		lineStart(baseline, hunk.oldStart + hunk.oldLines),
	);
	return { from, to, insert };
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
	syncHunk: SyncHunk | null,
): void {
	const { doc } = view.state;
	view.dispatch({
		changes: syncHunk
			? syncHunkRevert(doc, baseline, syncHunk)
			: chunkRevert(doc, baseline, chunk),
	});
}

function lineStart(text: Text, line: number): number {
	if (line < 1) return 0;
	if (line > text.lines) return text.length;
	return text.line(line).from;
}
