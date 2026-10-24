import type { Range, Text } from "@codemirror/state";
import {
	Decoration,
	type EditorView,
	GutterMarker,
	gutterWidgetClass,
	WidgetType,
} from "@codemirror/view";
import { setIcon } from "obsidian";
import type { LineRange } from "@/sync/hunks";
import type { Span } from "@/sync/merge-model";
import { firstIndex } from "@/utils";

const CONTEXT_LINES = 3;
/** A shorter run costs less to show than the row that would hide it. */
const MIN_GAP_LINES = 3;

/** One unchanged run between changes; its index names it the same in both panes. */
class UnchangedWidget extends WidgetType {
	constructor(
		private readonly index: number,
		private readonly count: number,
		readonly opened: boolean,
		private readonly toggle: (index: number) => void,
	) {
		super();
	}

	eq(other: UnchangedWidget): boolean {
		return (
			other.index === this.index &&
			other.count === this.count &&
			other.opened === this.opened
		);
	}

	toDOM(): HTMLElement {
		const text = `${this.opened ? "Hide" : "Show"} ${this.count} unchanged lines`;
		// Space around the bar goes on this slot: CodeMirror does not measure a widget's margins.
		const slot = createDiv({ cls: "mdsync-gap-slot" });
		slot.toggleClass("is-open", this.opened);
		const row = gapRow(
			this.opened ? "chevrons-down-up" : "chevrons-up-down",
			text,
			text,
			() => this.toggle(this.index),
		);
		row.toggleClass("is-fold", this.opened);
		slot.appendChild(row);
		return slot;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

/** Inline: the space above a short run's rows, which stay shown. */
class RunStartWidget extends WidgetType {
	eq(): boolean {
		return true;
	}

	toDOM(): HTMLElement {
		return createDiv({ cls: "mdsync-gap-slot is-spacer" });
	}
}

class GapGutter extends GutterMarker {
	elementClass = "mdsync-gap-gutter";
}
const GAP_GUTTER = new GapGutter();

/** A folded run's bar runs under the line numbers too. */
export const gapGutter = gutterWidgetClass.of((_view, widget) =>
	widget instanceof UnchangedWidget && !widget.opened ? GAP_GUTTER : null,
);

interface UnchangedRun {
	/** Its place among the gaps between changes, the same in both panes. */
	index: number;
	lines: number;
	/** Ends at the last line's end: taking its line break would merge the next line into the fold's block. */
	span: Span;
	/** A shorter run costs less to show than the row that would hide it. */
	foldable: boolean;
}

/** Unchanged runs between one side's changes (line ranges, in order); `context` lines stay by each change. */
function unchangedRuns(
	doc: Text,
	changes: readonly LineRange[],
	context = CONTEXT_LINES,
): UnchangedRun[] {
	const runs: UnchangedRun[] = [];
	for (let index = 0; index <= changes.length; index++) {
		const start =
			index === 0 ? 0 : (changes[index - 1] as LineRange)[1] + context;
		const end =
			index === changes.length
				? doc.lines
				: (changes[index] as LineRange)[0] - context;
		if (end <= start) continue;
		const span = { from: doc.line(start + 1).from, to: doc.line(end).to };
		const lines = end - start;
		runs.push({ index, lines, span, foldable: lines >= MIN_GAP_LINES });
	}
	return runs;
}

/**
 * Folds one pane's unchanged runs; `opened` is shared by both panes, so they fold and open together.
 * Inline keeps no context lines, and every shown run starts with a row of its own.
 */
export function addUnchangedGaps(
	ranges: Range<Decoration>[],
	doc: Text,
	changes: readonly LineRange[],
	opened: ReadonlySet<number>,
	toggle: (index: number) => void,
	inline: boolean,
): void {
	const context = inline ? 0 : CONTEXT_LINES;
	for (const run of unchangedRuns(doc, changes, context)) {
		const { index, lines, span, foldable } = run;
		if (foldable && !opened.has(index)) {
			const widget = new UnchangedWidget(index, lines, false, toggle);
			ranges.push(
				Decoration.replace({ widget, block: true }).range(span.from, span.to),
			);
			continue;
		}
		const head = foldable
			? new UnchangedWidget(index, lines, true, toggle)
			: inline
				? new RunStartWidget()
				: null;
		// After a card standing at the same place (side -10) and its fold row (-9).
		if (head) {
			ranges.push(
				Decoration.widget({ widget: head, block: true, side: -5 }).range(
					span.from,
				),
			);
		}
	}
}

/** Inline: unchanged rows on screen carry their numbers, as the cards carry none; folded rows are skipped. */
export function numberUnchangedLines(
	view: EditorView,
	changes: readonly LineRange[],
	lines: Range<Decoration>[],
): void {
	const { doc } = view.state;
	let next = 0;
	for (const { from, to } of view.visibleRanges) {
		const start = Math.max(next, doc.lineAt(from).number - 1);
		const end = doc.lineAt(to).number;
		let index = firstIndex(
			changes.length,
			(i) => (changes[i] as LineRange)[1] > start,
		);
		for (let n = start; n < end; n++) {
			while ((changes[index]?.[1] ?? Infinity) <= n) index++;
			const nextChange = changes[index]?.[0] ?? doc.lines;
			if (nextChange <= n) continue;
			// The run's real end closes its frame; the rendered window's edge must not.
			const last = n + 1 === nextChange ? " is-run-end" : "";
			lines.push(
				Decoration.line({
					class: `mdsync-unchanged-line${last}`,
					attributes: { "data-line": String(n + 1) },
				}).range(doc.line(n + 1).from),
			);
		}
		next = end;
	}
}

/** The folded runs of two panes, paired so the strip between them can join their bars. */
export function foldedBands(
	near: { doc: Text; changes: readonly LineRange[] },
	far: { doc: Text; changes: readonly LineRange[] },
	opened: ReadonlySet<number>,
): Array<{ near: Span; far: Span }> {
	const folded = (side: typeof near) =>
		unchangedRuns(side.doc, side.changes).filter(
			(run) => run.foldable && !opened.has(run.index),
		);
	const farSpans = new Map(folded(far).map((run) => [run.index, run.span]));
	return folded(near).flatMap(({ index, span }) => {
		const farSpan = farSpans.get(index);
		return farSpan ? [{ near: span, far: farSpan }] : [];
	});
}

export function gapRow(
	icon: string,
	text: string,
	label: string,
	onClick: () => void,
): HTMLElement {
	const button = createEl("button", { cls: "mdsync-gap" });
	button.type = "button";
	button.setAttribute("aria-label", label);
	const content = button.createSpan({ cls: "mdsync-gap-content" });
	const glyph = content.createSpan({ cls: "mdsync-gap-icon" });
	setIcon(glyph, icon);
	content.createSpan({ text });
	button.addEventListener("mousedown", (event) => event.preventDefault());
	button.addEventListener("click", onClick);
	return button;
}
