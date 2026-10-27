import type { Text } from "@codemirror/state";

import type { HunkSegment } from "@/features/sync";

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

function lineStart(text: Text, line: number): number {
	if (line < 1) return 0;
	if (line > text.lines) return text.length;
	return text.line(line).from;
}
