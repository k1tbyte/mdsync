import type { Text } from "@codemirror/state";
import {
	type EMergeSide,
	type MergeChange,
	snapToLines,
} from "@/sync/merge-model";
import type { DividerItem } from "./divider";
import { sideSpan } from "./geometry";
import { renderRailButton } from "./rail";

export interface MergeActions {
	apply(index: number, side: EMergeSide): void;
	ignore(index: number, side: EMergeSide): void;
	revert(index: number, side: EMergeSide): void;
}

export type MergeTone = "conflict" | EMergeSide | "base" | "shared";

export const PANE_LABEL: Record<EMergeSide, string> = {
	local: "Local (yours)",
	remote: "Remote (theirs)",
};

const TONE_LABEL: Record<MergeTone, string> = {
	local: "Local",
	remote: "Remote",
	shared: "Both sides",
	conflict: "Unresolved",
	base: "Base / manual edit",
};

export function renderMergeLegend(parent: HTMLElement): void {
	const legend = parent.createDiv({ cls: "mdsync-merge-legend" });
	const help = legend.createDiv({ cls: "mdsync-merge-help" });
	const button = renderRailButton(help, {
		icon: "info",
		label: "How to merge changes",
		run: () => {
			if (help.contains(document.activeElement)) button.blur();
			else button.focus();
		},
	});
	const hint = help.createDiv({
		cls: "mdsync-merge-help-text",
		text: "Use arrows to accept and × to reject. Accept both sides in the order you want. Non-conflicting changes start in Result. Nothing is written until you select Save and push.",
	});
	button.setAttr("aria-description", hint.textContent ?? "");
	for (const [tone, label] of Object.entries(TONE_LABEL)) {
		legend.createSpan({ cls: `mdsync-merge-key is-${tone}`, text: label });
	}
}

interface SideAction {
	icon: string;
	label: string;
	shortLabel: string;
	run: () => void;
}

export function sideActions(
	change: MergeChange,
	side: EMergeSide,
	handlers: MergeActions,
	acceptIcon = side === "local" ? "chevrons-right" : "chevrons-left",
): SideAction[] {
	const status = change.status[side];
	if (status === "none") return [];
	const kind =
		change[side][0] === change[side][1]
			? "deletion"
			: change.base[0] === change.base[1]
				? "addition"
				: "change";
	const accept = {
		icon: acceptIcon,
		label: `Accept ${kind}`,
		shortLabel: "Accept",
		run: () => handlers.apply(change.index, side),
	};
	const reject = {
		icon: "x",
		label: `Reject ${kind}`,
		shortLabel: "Reject",
		run: () =>
			status === "applied"
				? handlers.revert(change.index, side)
				: handlers.ignore(change.index, side),
	};
	if (status === "applied") return [reject];
	if (status === "ignored") return [accept];
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
	for (const change of changes) {
		const status = change.status[side];
		if (status === "none") continue;
		items.push({
			key: change.index,
			near: sideSpan(sideDoc, change[side]),
			far: snapToLines(resultDoc, change.taken[side] ?? change.result),
			tone: toneOf(change, side),
			actions: sideActions(change, side, handlers),
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
