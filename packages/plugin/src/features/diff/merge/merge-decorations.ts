import {
	type Extension,
	type Range,
	StateEffect,
	StateField,
	type Text,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { firstIndex } from "@/core/utils";
import {
	type EMergeSide,
	isResolved,
	MERGE_SIDES,
	type MergeChange,
	snapToLines,
} from "@/features/sync";
import { addCodeMarks } from "../lines/code-lines";
import { numberUnchangedLines } from "../lines/gap-widgets";
import { forEachVisibleRange, rangeLabel, sideSpan } from "../lines/geometry";
import {
	markLine,
	type Tints,
	tintLine,
	viewportTints,
} from "../lines/line-tints";
import { type SourceBlock, SourceBlockWidget } from "../lines/source-widget";
import type { MergeActions } from "./merge-actions";
import {
	type CombinedMergeConfig,
	mergeCards,
	openedGapsField,
	resultLines,
} from "./merge-cards";
import { type MergeTone, settleActions, toneOf } from "./merge-controls";
import type { SideMarks } from "./merge-marks";
import { mergeChangesField, rememberChangeState } from "./merge-state";

export const setCombinedMode = StateEffect.define<boolean>();
export const combinedModeField = StateField.define<boolean>({
	create: () => false,
	update: (combined, transaction) => {
		for (const effect of transaction.effects) {
			if (effect.is(setCombinedMode)) return effect.value;
		}
		return combined;
	},
});

export function mergeResultState(combined?: CombinedMergeConfig): Extension {
	const cards = combined && mergeCards(combined);
	const actions = combined?.actions;
	return [
		mergeChangesField,
		combinedModeField,
		openedGapsField,
		rememberChangeState,
		viewportTints(resultTints, (update) => {
			const changed = (field: StateField<unknown>) =>
				update.startState.field(field) !== update.state.field(field);
			return changed(mergeChangesField) || changed(combinedModeField);
		}),
		// Block widgets change the layout, so they cannot come from the viewport plugin.
		EditorView.decorations.compute(
			["doc", mergeChangesField, combinedModeField, openedGapsField],
			(state) => {
				if (cards && state.field(combinedModeField)) return cards(state);
				return actions
					? conflictHeads(state.doc, state.field(mergeChangesField), actions)
					: Decoration.none;
			},
		),
	];
}

function resultTints(view: EditorView, tints: Tints): void {
	const { doc } = view.state;
	const changes = view.state.field(mergeChangesField);
	const { from: top, to: bottom } = view.viewport;
	// A span ending just above the viewport can still snap onto its first line.
	const start = firstIndex(
		changes.length,
		(index) => (changes[index] as MergeChange).result.to >= top - 1,
	);
	const combined = view.state.field(combinedModeField);
	for (let index = start; index < changes.length; index++) {
		const change = changes[index] as MergeChange;
		if (change.result.from > bottom) break;
		addResultTint(tints, doc, change, top, bottom, combined);
	}
	if (combined) {
		const lines = changes.map((change) => resultLines(doc, change));
		numberUnchangedLines(view, lines, tints.lines);
	}
}

function addResultTint(
	tints: Tints,
	doc: Text,
	change: MergeChange,
	top: number,
	bottom: number,
	combined: boolean,
): void {
	const span = snapToLines(doc, change.result);
	const resolved = isResolved(change);
	const parts = MERGE_SIDES.flatMap((side) => {
		const part = change.taken[side];
		return part ? [{ side, span: snapToLines(doc, part) }] : [];
	});
	const rest: MergeTone = resolved ? "base" : "conflict";
	if (span.to <= span.from) {
		// Inline, the card marks the place.
		if (combined) return;
		const owners = parts.filter((part) => part.span.from === span.from);
		const tone = owners.length > 1 ? "shared" : (owners[0]?.side ?? rest);
		markLine(tints, doc, span.from, `is-${tone}`);
		return;
	}
	// Inline: an open conflict's card closes with its row of choices, any other with its last row.
	const closing = resolved ? doc.lineAt(span.to - 1).number : -1;
	const last = doc.lineAt(Math.min(span.to - 1, bottom)).number;
	for (let n = doc.lineAt(Math.max(span.from, top)).number; n <= last; n++) {
		const at = doc.line(n).from;
		const owners = parts.filter(
			(part) => at >= part.span.from && at < part.span.to,
		);
		const tone = owners.length > 1 ? "shared" : (owners[0]?.side ?? rest);
		tintLine(tints, at, `is-${tone}`, n === closing ? " is-last" : "");
	}
}

/** Side by side: each open conflict gets a head in Result that settles it in one step. */
function conflictHeads(
	doc: Text,
	changes: readonly MergeChange[],
	actions: MergeActions,
): DecorationSet {
	const ranges: Range<Decoration>[] = [];
	for (const change of changes) {
		if (isResolved(change)) continue;
		const span = snapToLines(doc, change.result);
		const first = doc.lineAt(span.from).number;
		const last = doc.lineAt(Math.max(span.from, span.to - 1)).number;
		const block: SourceBlock = {
			key: `conflict-${change.index}`,
			tone: "conflict",
			head: {
				mark: "conflict",
				text:
					span.to > span.from
						? `Both changed ${last > first ? "lines" : "line"} ${rangeLabel(first, last)}`
						: "Both added lines here",
				actions: settleActions(change, actions),
			},
			lines: [],
			firstLine: first,
		};
		ranges.push(
			Decoration.widget({
				widget: new SourceBlockWidget(block),
				block: true,
				side: -1,
			}).range(span.from),
		);
	}
	return Decoration.set(ranges, true);
}

const setSideChanges = StateEffect.define<readonly MergeChange[]>();

const sideChangesField = StateField.define<readonly MergeChange[]>({
	create: () => [],
	update: (changes, transaction) => {
		for (const effect of transaction.effects) {
			if (effect.is(setSideChanges)) return effect.value;
		}
		return changes;
	},
});

/** A side pane's tints and word marks, drawn for its viewport from the changes the Result last published. */
export function sideDecorations(side: EMergeSide, marks: SideMarks): Extension {
	return [
		sideChangesField,
		viewportTints(
			(view, tints) => sideTints(view, tints, side, marks),
			(update) =>
				update.startState.field(sideChangesField) !==
				update.state.field(sideChangesField),
		),
	];
}

export function showSideChanges(
	view: EditorView,
	changes: readonly MergeChange[],
): void {
	view.dispatch({ effects: setSideChanges.of(changes) });
}

function sideTints(
	view: EditorView,
	tints: Tints,
	side: EMergeSide,
	marks: SideMarks,
): void {
	const { doc } = view.state;
	forEachVisibleRange(
		view,
		view.state.field(sideChangesField),
		(change) => change[side],
		(change, first, end) => {
			const tone = toneOf(change, side);
			const [from, to] = change[side];
			if (to <= from) {
				markLine(tints, doc, sideSpan(doc, change[side]).from, `is-${tone}`);
				return;
			}
			const marksAt = marks(change, side);
			for (let n = first; n < end; n++) {
				const line = doc.line(n + 1);
				tintLine(tints, line.from, `is-${tone}`);
				if (marksAt) addCodeMarks(tints.lines, line, marksAt(n - from));
			}
		},
	);
}
