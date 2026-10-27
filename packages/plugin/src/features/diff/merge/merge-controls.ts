import type { Text } from "@codemirror/state";
import {
	type EMergeSide,
	type MergeChange,
	snapToLines,
} from "@/features/sync/hunks/merge-model";
import type { DividerItem } from "../lines/divider";
import { sideSpan } from "../lines/geometry";
import type { RailAction } from "../rail";
import type { MergeActions } from "./merge-actions";

export type MergeTone = "conflict" | EMergeSide | "base" | "shared";

/** On the strips an open conflict is only taken: it is settled from its head in Result. */
export function sideActions(
	change: MergeChange,
	side: EMergeSide,
	handlers: MergeActions,
): RailAction[] {
	const status = change.status[side];
	if (status === "none") return [];
	const kind =
		change[side][0] === change[side][1]
			? "deletion"
			: change.base[0] === change.base[1]
				? "addition"
				: "change";
	if (status === "applied") {
		return [
			{
				icon: "x",
				label: `Reject ${side} ${kind}`,
				shortLabel: "Reject",
				run: () => handlers.revert(change.index, side),
			},
		];
	}
	return [
		{
			icon: side === "local" ? "chevrons-right" : "chevrons-left",
			label: `Take ${side} ${kind}`,
			shortLabel: "Take",
			cls: "is-take",
			run: () => handlers.apply(change.index, side),
		},
	];
}

/** A conflict's ways out: name, button text, the sides taken in order. */
const SETTLE: readonly [string, string, readonly EMergeSide[]][] = [
	["Take local", "Local", ["local"]],
	["Take remote", "Remote", ["remote"]],
	["Take both, local first", "Both", ["local", "remote"]],
];

export function settleActions(
	change: MergeChange,
	handlers: MergeActions,
): RailAction[] {
	return SETTLE.map(([label, shortLabel, sides]) => ({
		icon: "",
		label,
		shortLabel,
		cls: `is-${sides.join("-")}`,
		run: () => handlers.settle(change.index, sides),
	}));
}

/** The connectors between one side pane and the result: one per change that side took part in. */
export function dividerItems(
	changes: readonly MergeChange[],
	side: EMergeSide,
	sideDoc: Text,
	resultDoc: Text,
	handlers: MergeActions,
): DividerItem[] {
	const items: DividerItem[] = [];
	for (const change of changes) {
		const status = change.status[side];
		if (status === "none") continue;
		items.push({
			key: change.index,
			near: sideSpan(sideDoc, change[side]),
			far: snapToLines(resultDoc, change.taken[side] ?? change.result),
			tone: toneOf(change, side),
			actions: sideActions(change, side, handlers),
			// Few enough to keep every change's buttons in reach, as IntelliJ does.
			pinned: true,
		});
	}
	return items;
}

export function toneOf(change: MergeChange, side: EMergeSide): MergeTone {
	const status = change.status[side];
	if (status === "open") return "conflict";
	if (status === "applied") return side;
	return "base";
}
