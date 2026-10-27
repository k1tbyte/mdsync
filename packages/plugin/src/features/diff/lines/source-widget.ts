import { type EditorView, WidgetType } from "@codemirror/view";
import { setIcon } from "obsidian";
import { type Span, sameLines } from "@/features/sync";
import { type RailAction, renderRailButton } from "../rail";
import { renderCodeLine } from "./code-lines";
import { gapRow } from "./gap-widgets";

/** A widget is drawn whole, never windowed; past this a block shows its start and offers the rest. */
const BLOCK_MAX_LINES = 300;

export interface LineCounters {
	added: number;
	removed: number;
}

/** A row naming a side; its actions take that side. */
export interface BlockLabel {
	/** A dot in this tone before the text; "chosen" draws a check. */
	mark?: string;
	text: string;
	counters?: LineCounters;
	actions?: RailAction[];
}

interface SourceLines {
	/** Tint of the header and the line bars. */
	tone: string;
	lines: readonly string[];
	firstLine: number;
	/** Marks of the line at `offset`; one function for as long as the lines it reads stay the same. */
	marks?: (offset: number) => readonly Span[];
	/** Without it, no lines show nothing. */
	emptyText?: string;
}

/** A labelled run of lines after the block's own. */
export interface SourcePart extends SourceLines {
	label: BlockLabel;
}

/** One change shown in combined mode: a labelled block of lines. */
export interface SourceBlock extends SourceLines {
	key: string;
	head: BlockLabel;
	parts?: readonly SourcePart[];
	/** Optional closing row naming what follows the block in the document. */
	trailer?: BlockLabel;
	/** Region edges: the block that opens or closes a change's box. */
	opens?: boolean;
	closes?: boolean;
	chosen?: boolean;
	/** Only the head and trailer show; the lines are folded away. */
	folded?: boolean;
}

function renderSourceBlock(
	parent: HTMLElement,
	block: SourceBlock,
	onResize: () => void,
): HTMLElement {
	const wrap = parent.createEl("section", {
		cls: `mdsync-source is-${block.tone}`,
	});
	wrap.dataset.change = block.key;
	wrap.toggleClass("is-opening", block.opens === true);
	wrap.toggleClass("is-closing", block.closes === true);
	wrap.toggleClass("is-chosen", block.chosen === true);
	renderLabel(wrap, block.key, block.head);
	if (!block.folded) renderBody(wrap, block, onResize);
	for (const part of block.parts ?? []) {
		const el = wrap.createDiv({ cls: `mdsync-source-part is-${part.tone}` });
		renderLabel(el, block.key, part.label).addClass("is-part");
		renderBody(el, part, onResize);
	}
	if (block.trailer) {
		renderLabel(wrap, block.key, block.trailer).addClass("is-trailer");
	}
	return wrap;
}

function renderBody(
	wrap: HTMLElement,
	block: SourceLines,
	onResize: () => void,
): void {
	if (block.lines.length === 0 && !block.emptyText) return;
	const lines = wrap.createDiv({ cls: "mdsync-source-lines" });
	if (block.lines.length === 0) {
		lines.addClass("is-empty");
		lines.setText(block.emptyText ?? "");
	}
	const shown = Math.min(block.lines.length, BLOCK_MAX_LINES);
	renderLines(lines, block, 0, shown);
	const hidden = block.lines.length - shown;
	if (hidden > 0) {
		const more = gapRow(
			"unfold-vertical",
			`Show ${hidden} more lines`,
			`Show ${hidden} more lines of this block`,
			() => {
				more.remove();
				renderLines(lines, block, shown, block.lines.length);
				onResize();
			},
		);
		wrap.appendChild(more);
	}
}

function renderLines(
	parent: HTMLElement,
	block: SourceLines,
	from: number,
	to: number,
): void {
	for (let offset = from; offset < to; offset++) {
		renderCodeLine(
			parent,
			{
				number: block.firstLine + offset,
				text: block.lines[offset] as string,
				marks: block.marks?.(offset),
			},
			block.tone,
		);
	}
}

/** The change a key press acted on: its redrawn actions take the focus back, so the keyboard keeps its place. */
let refocusChange: string | null = null;

/** Keys are `<part>-<change index>`: settling moves the actions from a change's foot to its card. */
const changeOf = (key: string): string => key.slice(key.indexOf("-") + 1);

function renderLabel(
	parent: HTMLElement,
	key: string,
	label: BlockLabel,
): HTMLElement {
	const head = parent.createDiv({ cls: "mdsync-source-head" });
	if (label.mark) {
		const mark = head.createSpan({
			cls: `mdsync-source-mark is-${label.mark}`,
		});
		if (label.mark === "chosen") setIcon(mark, "check");
	}
	head.createSpan({ cls: "mdsync-source-label", text: label.text });
	if (label.counters) renderCounters(head, label.counters);
	if (!label.actions || label.actions.length === 0) return head;
	const actions = head.createDiv({ cls: "mdsync-source-actions" });
	for (const action of label.actions) {
		renderRailButton(actions, {
			...action,
			run: () => {
				// A mouse press never focuses these: only the keyboard's place is kept.
				const focused = actions.contains(actions.ownerDocument.activeElement);
				refocusChange = focused ? changeOf(key) : null;
				try {
					action.run();
				} finally {
					refocusChange = null;
				}
			},
		});
	}
	return head;
}

export function renderCounters(
	parent: HTMLElement,
	counters: LineCounters,
): HTMLElement {
	const wrap = parent.createSpan({ cls: "mdsync-counters" });
	if (counters.added > 0) {
		wrap.createSpan({ cls: "is-added", text: `+${counters.added}` });
	}
	if (counters.removed > 0) {
		wrap.createSpan({ cls: "is-removed", text: `−${counters.removed}` });
	}
	return wrap;
}

export class SourceBlockWidget extends WidgetType {
	private readonly signature: string;

	constructor(private readonly block: SourceBlock) {
		super();
		// Lines are compared in `eq`: joining them here copied every change on each redraw.
		this.signature = [
			block.key,
			block.tone,
			block.opens ? "opens" : "",
			block.closes ? "closes" : "",
			block.chosen ? "chosen" : "",
			block.folded ? "folded" : "",
			labelKey(block.head),
			labelKey(block.trailer),
			String(block.firstLine),
			...(block.parts ?? []).map(
				(part) => `${part.tone}:${part.firstLine}:${labelKey(part.label)}`,
			),
		].join("\u0000");
	}

	eq(other: SourceBlockWidget): boolean {
		const parts = this.block.parts ?? [];
		return (
			other.signature === this.signature &&
			sameSourceLines(other.block, this.block) &&
			parts.every((part, i) => {
				const otherPart = other.block.parts?.[i];
				return otherPart !== undefined && sameSourceLines(otherPart, part);
			})
		);
	}

	toDOM(view: EditorView): HTMLElement {
		// Space around the block goes on this slot: CodeMirror does not measure a widget's margins.
		const slot = createDiv({ cls: "mdsync-source-slot" });
		slot.toggleClass(
			"is-card-end",
			this.block.closes === true && this.block.opens !== true,
		);
		renderSourceBlock(slot, this.block, () => view.requestMeasure());
		if (refocusChange === changeOf(this.block.key)) {
			// Mounted once the dispatch that drew it returns.
			queueMicrotask(() =>
				slot
					.querySelector<HTMLElement>(".mdsync-source-actions button")
					?.focus(),
			);
		}
		return slot;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

function sameSourceLines(a: SourceLines, b: SourceLines): boolean {
	return a.marks === b.marks && sameLines(a.lines, b.lines);
}

function labelKey(label: BlockLabel | undefined): string {
	if (!label) return "";
	const { mark, text, counters, actions = [] } = label;
	return [
		mark ?? "",
		text,
		counters ? `${counters.added}/${counters.removed}` : "",
		actions.map((a) => `${a.icon}${a.active ? "*" : ""}`).join(","),
	].join("");
}
