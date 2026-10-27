import {
	type EditorState,
	type Range,
	StateEffect,
	StateField,
	type Text,
} from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";
import type { LineRange } from "@/features/sync";
import {
	type EMergeSide,
	isResolved,
	MERGE_SIDES,
	type MergeChange,
	snapToLines,
} from "@/features/sync";
import { addUnchangedGaps } from "../lines/gap-widgets";
import { rangeLabel } from "../lines/geometry";
import { type SourceBlock, SourceBlockWidget } from "../lines/source-widget";
import type { RailAction } from "../rail";
import type { MergeActions } from "./merge-actions";
import { settleActions } from "./merge-controls";
import type { SideMarks } from "./merge-marks";
import { mergeChangesField } from "./merge-state";

export interface CombinedMergeConfig {
	actions: MergeActions;
	base: readonly string[];
	sides: Record<EMergeSide, readonly string[]>;
	marks: SideMarks;
	/** Opens or folds the unchanged run before the change at this index. */
	toggleGap: (index: number) => void;
}

export const toggleMergeGap = StateEffect.define<number>();

/** Indices of the unchanged runs opened between cards. */
export const openedGapsField = StateField.define<ReadonlySet<number>>({
	create: () => new Set(),
	update: (opened, transaction) => {
		let next = opened;
		for (const effect of transaction.effects) {
			if (!effect.is(toggleMergeGap)) continue;
			const copy = new Set(next);
			if (!copy.delete(effect.value)) copy.add(effect.value);
			next = copy;
		}
		return next;
	},
});

const SIDE_LABEL: Record<EMergeSide, string> = {
	local: "Local",
	remote: "Remote",
};

/**
 * Inline: every change is a card over its Result rows. An open conflict shows both sides and closes with a row
 * that settles it; any other card closes with its last row.
 */
export function mergeCards(config: CombinedMergeConfig) {
	return (state: EditorState): DecorationSet => {
		const { doc } = state;
		const changes = state.field(mergeChangesField);
		const ranges: Range<Decoration>[] = [];
		const lines = changes.map((change) => resultLines(doc, change));
		changes.forEach((change, i) => {
			const span = snapToLines(doc, change.result);
			const at = lines[i] as LineRange;
			const block = card(change, at, config, () =>
				doc.sliceString(span.from, span.to),
			);
			ranges.push(blockAt(doc, span.from, -10, block));
			if (!isResolved(change)) {
				// Before the next card's head where they meet; after its own head when the span is empty.
				const side = span.to > span.from ? -11 : -9;
				ranges.push(blockAt(doc, span.to, side, foot(change, config.actions)));
			}
		});
		addUnchangedGaps(
			ranges,
			doc,
			lines,
			state.field(openedGapsField),
			config.toggleGap,
			true,
		);
		return Decoration.set(ranges, true);
	};
}

/** The 0-based lines a change holds in Result; an empty one sits before a line, or after the last. */
export function resultLines(doc: Text, change: MergeChange): LineRange {
	const span = snapToLines(doc, change.result);
	const line = doc.lineAt(span.from);
	const start = span.from === line.from ? line.number - 1 : line.number;
	return [start, span.to > span.from ? doc.lineAt(span.to - 1).number : start];
}

/** Rows stand above their place; past the last line of a file without a final newline, below it. */
function blockAt(
	doc: Text,
	at: number,
	side: number,
	block: SourceBlock,
): Range<Decoration> {
	const lineStart = doc.lineAt(at).from === at;
	return Decoration.widget({
		widget: new SourceBlockWidget(block),
		block: true,
		side: lineStart ? side : side + 20,
	}).range(at);
}

function card(
	change: MergeChange,
	[start, end]: LineRange,
	config: CombinedMergeConfig,
	result: () => string,
): SourceBlock {
	const where =
		end > start
			? `${end - start > 1 ? "Lines" : "Line"} ${rangeLabel(start + 1, end)}`
			: start > 0
				? `After line ${start}`
				: "Start of file";
	const base = {
		key: `card-${change.index}`,
		opens: true,
		closes: end <= start,
	};
	const none = { tone: "base", lines: [], firstLine: 0 };
	if (!isResolved(change)) {
		return {
			...base,
			...none,
			tone: "conflict",
			head: { mark: "conflict", text: `${where} · conflict` },
			parts: MERGE_SIDES.map((side) => ({
				label: { mark: side, text: SIDE_LABEL[side] },
				tone: side,
				lines: config.sides[side].slice(...change[side]),
				firstLine: change[side][0] + 1,
				marks: config.marks(change, side),
				emptyText: "No lines (deleted)",
			})),
			trailer: { text: "Result" },
			closes: false,
		};
	}
	const changed = MERGE_SIDES.filter((side) => change.status[side] !== "none");
	const taken = MERGE_SIDES.filter((side) => change.status[side] === "applied");
	const { actions } = config;
	if (!change.conflict && taken.length === changed.length) {
		// Taken by itself: the lines it replaced, then its rows in Result.
		const reject: RailAction = {
			icon: "x",
			label: "Reject change",
			shortLabel: "Reject",
			run: () => actions.settle(change.index, []),
		};
		return {
			...base,
			tone: "base",
			head: {
				mark: changed.length > 1 ? "shared" : changed[0],
				text: `${where} · from ${names(changed)}`,
				actions: [reject],
			},
			lines: config.base.slice(...change.base),
			firstLine: change.base[0] + 1,
		};
	}
	const undo: RailAction = {
		icon: "",
		label: "Undo choice",
		shortLabel: "Undo choice",
		run: () =>
			change.conflict
				? actions.reopen(change.index)
				: actions.settle(change.index, changed),
	};
	// Rejecting puts the base lines back; anything else there was typed.
	const leftOut = () =>
		!change.conflict &&
		result().replace(/\n$/, "") ===
			config.base.slice(...change.base).join("\n");
	const choice =
		taken.length > 0
			? `took ${names(taken)}`
			: leftOut()
				? `${names(changed)} left out`
				: "edited by hand";
	return {
		...base,
		...none,
		head: { mark: "chosen", text: `${where} · ${choice}`, actions: [undo] },
	};
}

function names(sides: readonly EMergeSide[]): string {
	return sides.length > 1 ? "both" : SIDE_LABEL[sides[0] as EMergeSide];
}

/** An open conflict's last row: its ways out. */
function foot(change: MergeChange, actions: MergeActions): SourceBlock {
	return {
		key: `foot-${change.index}`,
		tone: "conflict",
		head: { text: "", actions: settleActions(change, actions) },
		lines: [],
		firstLine: 0,
		closes: true,
	};
}
