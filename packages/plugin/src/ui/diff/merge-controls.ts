import type { Text } from "@codemirror/state";
import {
	type EMergeSide,
	type MergeChange,
	snapToLines,
} from "@/sync/merge-model";
import type { DividerItem } from "./divider";
import { sideSpan } from "./geometry";
import type { MergeActions } from "./merge-actions";
import type { RailAction } from "./rail";

export type MergeTone = "conflict" | EMergeSide | "base" | "shared";

interface SideActionStyle {
	acceptIcon: string;
	/** Off on the strips: there an open conflict is settled from its head in Result. */
	rejectOpen: boolean;
}

export function sideActions(
	change: MergeChange,
	side: EMergeSide,
	handlers: MergeActions,
	style: SideActionStyle,
): RailAction[] {
	const status = change.status[side];
	if (status === "none") return [];
	const kind =
		change[side][0] === change[side][1]
			? "deletion"
			: change.base[0] === change.base[1]
				? "addition"
				: "change";
	const accept = {
		icon: style.acceptIcon,
		label: `Take ${side} ${kind}`,
		shortLabel: "Take",
		cls: "is-take",
		run: () => handlers.apply(change.index, side),
	};
	const reject = {
		icon: "x",
		label: `Reject ${side} ${kind}`,
		shortLabel: "Reject",
		run: () =>
			status === "applied"
				? handlers.revert(change.index, side)
				: handlers.ignore(change.index, side),
	};
	if (status === "applied") return [reject];
	if (status === "ignored" || !style.rejectOpen) return [accept];
	return side === "local" ? [reject, accept] : [accept, reject];
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
	const acceptIcon = side === "local" ? "chevrons-right" : "chevrons-left";
	for (const change of changes) {
		const status = change.status[side];
		if (status === "none") continue;
		items.push({
			key: change.index,
			near: sideSpan(sideDoc, change[side]),
			far: snapToLines(resultDoc, change.taken[side] ?? change.result),
			tone: toneOf(change, side),
			actions: sideActions(change, side, handlers, {
				acceptIcon,
				rejectOpen: false,
			}),
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
