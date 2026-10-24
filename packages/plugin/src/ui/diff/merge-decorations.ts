import {
	type Extension,
	type Range,
	StateEffect,
	StateField,
	type Text,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { computeHunks } from "@/sync/hunks";
import {
	type EMergeSide,
	isResolved,
	MERGE_SIDES,
	type MergeChange,
	type Span,
	snapToLines,
} from "@/sync/merge-model";
import { firstIndex } from "@/utils";
import { addCodeMarks, type LineMarks, lineMarks } from "./code-lines";
import { addCollapsedGaps, expandedGapsField } from "./gap-widgets";
import { forEachVisibleRange, rangeLabel, sideSpan } from "./geometry";
import { markLine, type Tints, tintLine, viewportTints } from "./line-tints";
import type { MergeActions } from "./merge-actions";
import { type MergeTone, sideActions, toneOf } from "./merge-controls";
import { mergeChangesField, rememberChangeState } from "./merge-state";
import type { RailAction } from "./rail";
import {
	type LineCounters,
	type SourceBlock,
	SourceBlockWidget,
} from "./source-widget";

const SIDE_LABEL: Record<EMergeSide, string> = {
	local: "Local",
	remote: "Remote",
};

/** Word marks of a side's lines against the base lines of the same change; none where the side did not change. */
export type SideMarks = (
	change: MergeChange,
	side: EMergeSide,
) => ((offset: number) => readonly Span[]) | undefined;

export interface CombinedMergeConfig {
	actions: MergeActions;
	base: readonly string[];
	sides: Record<EMergeSide, readonly string[]>;
	marks: SideMarks;
}

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

/**
 * One marks function per change side for the session: ranges never move, so lines are diffed once and
 * blocks keep identity.
 */
export function sideMarks(
	base: readonly string[],
	sides: Record<EMergeSide, readonly string[]>,
): SideMarks {
	const cache = new Map<string, (offset: number) => readonly Span[]>();
	return (change, side) => {
		if (change.status[side] === "none") return undefined;
		const key = `${change.index}:${side}`;
		let marks = cache.get(key);
		if (!marks) {
			const lines: LineMarks[] = [];
			const [baseStart] = change.base;
			const [sideStart] = change[side];
			marks = (offset) => {
				lines[offset] ??= lineMarks(
					base[baseStart + offset],
					sides[side][sideStart + offset],
				);
				return lines[offset].added;
			};
			cache.set(key, marks);
		}
		return marks;
	};
}

export function mergeResultState(combined?: CombinedMergeConfig): Extension {
	const blocks = combined && combinedBlocks(combined);
	const actions = combined?.actions;
	return [
		mergeChangesField,
		combinedModeField,
		expandedGapsField,
		rememberChangeState,
		viewportTints(
			resultTints,
			(update) =>
				update.startState.field(mergeChangesField) !==
				update.state.field(mergeChangesField),
		),
		// Block widgets change the layout, so they cannot come from the viewport plugin.
		EditorView.decorations.compute(
			["doc", mergeChangesField, combinedModeField, expandedGapsField],
			(state) => {
				const changes = state.field(mergeChangesField);
				if (blocks && state.field(combinedModeField)) {
					return blocks(state.doc, changes, state.field(expandedGapsField));
				}
				return actions
					? conflictHeads(state.doc, changes, actions)
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
	for (let index = start; index < changes.length; index++) {
		const change = changes[index] as MergeChange;
		if (change.result.from > bottom) break;
		addResultTint(tints, doc, change, top, bottom);
	}
}

function addResultTint(
	tints: Tints,
	doc: Text,
	change: MergeChange,
	top: number,
	bottom: number,
): void {
	const span = snapToLines(doc, change.result);
	const resolved = isResolved(change);
	const parts = MERGE_SIDES.flatMap((side) => {
		const part = change.taken[side];
		return part ? [{ side, span: snapToLines(doc, part) }] : [];
	});
	const rest: MergeTone = resolved ? "base" : "conflict";
	if (span.to <= span.from) {
		const owners = parts.filter((part) => part.span.from === span.from);
		const tone = owners.length > 1 ? "shared" : (owners[0]?.side ?? rest);
		markLine(tints, doc, span.from, `is-${tone}`);
		return;
	}
	const last = doc.lineAt(Math.min(span.to - 1, bottom)).number;
	for (let n = doc.lineAt(Math.max(span.from, top)).number; n <= last; n++) {
		const at = doc.line(n).from;
		const owners = parts.filter(
			(part) => at >= part.span.from && at < part.span.to,
		);
		const tone = owners.length > 1 ? "shared" : (owners[0]?.side ?? rest);
		tintLine(tints, at, `is-${tone}`);
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
				actions: SETTLE.map(([label, shortLabel, sides]) => ({
					icon: "",
					label,
					shortLabel,
					cls: `is-${sides.join("-")}`,
					run: () => actions.settle(change.index, sides),
				})),
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

/** A conflict head's ways out: name, button text, the sides taken in order. */
const SETTLE: readonly [string, string, readonly EMergeSide[]][] = [
	["Take local", "Local", ["local"]],
	["Take remote", "Remote", ["remote"]],
	["Take both, local first", "Both", ["local", "remote"]],
];

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

/** Combined mode's source blocks and gaps; Result counters recompute only for changes whose result lines moved. */
function combinedBlocks(config: CombinedMergeConfig) {
	const counted = new Map<number, { text: string; counters: LineCounters }>();
	const countersOf = (doc: Text, change: MergeChange): LineCounters => {
		const text = resultText(doc, change.result);
		const hit = counted.get(change.index);
		if (hit?.text === text) return hit.counters;
		const counters = resultCounters(
			config.base.slice(change.base[0], change.base[1]).join("\n"),
			text,
		);
		counted.set(change.index, { text, counters });
		return counters;
	};
	return (
		doc: Text,
		changes: readonly MergeChange[],
		expanded: DecorationSet,
	): DecorationSet => {
		const ranges: Range<Decoration>[] = [];
		for (const change of changes) {
			const span = snapToLines(doc, change.result);
			ranges.push(
				Decoration.widget({
					widget: new SourceBlockWidget(
						sourceBlock(change, "local", config, countersOf(doc, change)),
					),
					block: true,
					side: -10,
				}).range(span.from),
				Decoration.widget({
					widget: new SourceBlockWidget(sourceBlock(change, "remote", config)),
					block: true,
					side: -9,
				}).range(span.to),
			);
		}
		addCollapsedGaps(
			ranges,
			doc,
			changes.map((change) => change.result),
			expanded,
		);
		return Decoration.set(ranges, true);
	};
}

/**
 * One side's block of a change in combined mode: LOCAL opens the region and carries the Result trailer,
 * REMOTE closes it.
 */
function sourceBlock(
	change: MergeChange,
	side: EMergeSide,
	config: CombinedMergeConfig,
	resultCounters?: LineCounters,
): SourceBlock {
	const range = change[side];
	const block: SourceBlock = {
		key: `${change.index}-${side}`,
		tone: side,
		head: {
			text: SIDE_LABEL[side],
			actions: combinedActions(change, side, config.actions),
		},
		lines: config.sides[side].slice(range[0], range[1]),
		firstLine: range[0] + 1,
		marks: config.marks(change, side),
		emptyText: "No lines (deleted)",
		opens: side === "local",
		closes: side === "remote",
		chosen: change.status[side] === "applied",
	};
	if (resultCounters) {
		block.trailer = { text: "Result", counters: resultCounters };
	}
	return block;
}

function combinedActions(
	change: MergeChange,
	side: EMergeSide,
	actions: MergeActions,
): RailAction[] {
	return sideActions(change, side, actions, {
		acceptIcon: side === "local" ? "chevrons-down" : "chevrons-up",
		rejectOpen: true,
	});
}

/** +added/-removed of what the result currently holds for this change, against base. */
function resultCounters(base: string, result: string): LineCounters {
	const { hunks } = computeHunks(base, result);
	let added = 0;
	let removed = 0;
	for (const hunk of hunks) {
		added += hunk.added;
		removed += hunk.removed;
	}
	return { added, removed };
}

/** The change's whole result lines, joined without the final line break. */
function resultText(doc: Text, span: Span): string {
	const snapped = snapToLines(doc, span);
	const text = doc.sliceString(snapped.from, snapped.to);
	return text.endsWith("\n") ? text.slice(0, -1) : text;
}
