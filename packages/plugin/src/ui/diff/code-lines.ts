import type { Range } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import type { Span } from "@/sync/merge-model";
import { type DiffRange, diffRanges } from "@/utils";

/** Past these, word marks cost more than they tell; the line tint still shows the change. */
const MARK_MAX_LINE_CHARS = 10_000;
const MARK_BUDGET = 500_000;
/** Word runs in any script, space runs, any other character alone. */
const WORD_TOKENS = /[\p{L}\p{M}\p{N}_]+|\s+|./gu;

export interface CodeLine {
	number?: number;
	text: string;
	/** Character spans inside `text` that differ from the paired line. */
	marks?: readonly Span[];
}

export interface LineMarks {
	removed: readonly Span[];
	added: readonly Span[];
}

const NO_MARKS: LineMarks = { removed: [], added: [] };
const CODE_MARK = Decoration.mark({ class: "mdsync-code-mark" });

/**
 * One line of a source block or preview, in the DOM the CodeMirror panes imitate so widget and editor lines
 * look alike.
 */
export function renderCodeLine(
	parent: HTMLElement,
	line: CodeLine,
	tone?: string,
): HTMLElement {
	const row = parent.createDiv({ cls: "mdsync-code-line" });
	if (tone) row.addClass(`is-${tone}`);
	row.createSpan({
		cls: "mdsync-code-number",
		text: line.number === undefined ? "" : String(line.number),
	});
	const text = row.createSpan({ cls: "mdsync-code-text" });
	let cursor = 0;
	for (const mark of line.marks ?? []) {
		if (mark.from > cursor) text.appendText(line.text.slice(cursor, mark.from));
		text.createSpan({
			cls: "mdsync-code-mark",
			text: line.text.slice(mark.from, mark.to),
		});
		cursor = mark.to;
	}
	text.appendText(line.text.slice(cursor));
	return row;
}

export function addCodeMarks(
	ranges: Range<Decoration>[],
	line: { from: number; to: number },
	marks: readonly Span[],
): void {
	for (const mark of marks) {
		const from = Math.min(line.from + mark.from, line.to);
		const to = Math.min(line.from + mark.to, line.to);
		if (to > from) ranges.push(CODE_MARK.range(from, to));
	}
}

/** Word-level differences between a removed line and the added line paired with it by position. */
export function lineMarks(
	removed: string | undefined,
	added: string | undefined,
): LineMarks {
	if (removed === undefined || added === undefined) return NO_MARKS;
	if (
		removed.length > MARK_MAX_LINE_CHARS ||
		added.length > MARK_MAX_LINE_CHARS
	) {
		return NO_MARKS;
	}
	const a = removed.match(WORD_TOKENS) ?? [];
	const b = added.match(WORD_TOKENS) ?? [];
	const ranges = diffRanges(a, b, MARK_BUDGET);
	if (!ranges) return NO_MARKS;
	const marks = {
		removed: spansOf(a, ranges, "a"),
		added: spansOf(b, ranges, "b"),
	};
	let marked = 0;
	for (const span of [...marks.removed, ...marks.added]) {
		marked += span.to - span.from;
	}
	// Whole-line marks say nothing; only lines that share something get them.
	return marked < removed.length + added.length ? marks : NO_MARKS;
}

/** One side's token ranges as character spans, the empty ones left out. */
function spansOf(
	tokens: readonly string[],
	ranges: readonly DiffRange[],
	side: keyof DiffRange,
): Span[] {
	const starts = [0];
	for (const token of tokens)
		starts.push((starts.at(-1) as number) + token.length);
	return ranges
		.filter((range) => range[side][1] > range[side][0])
		.map((range) => ({
			from: starts[range[side][0]] as number,
			to: starts[range[side][1]] as number,
		}));
}
