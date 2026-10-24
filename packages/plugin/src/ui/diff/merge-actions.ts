import { isolateHistory } from "@codemirror/commands";
import { ChangeSet, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
	applyPlan,
	type EditPlan,
	type EMergeSide,
	type ESideStatus,
	MERGE_SIDES,
	type MergeChange,
	revertPlan,
	type StatusPatch,
} from "@/sync/merge-model";
import { fullTaken, mergeChangesField, setChangeState } from "./merge-state";

export interface MergeActions {
	apply(index: number, side: EMergeSide): void;
	ignore(index: number, side: EMergeSide): void;
	revert(index: number, side: EMergeSide): void;
	/** Takes these sides in order and drops the other: a conflict settled in one step. */
	settle(index: number, sides: readonly EMergeSide[]): void;
}

export interface MergeSource {
	view: EditorView | null;
	sides: Record<EMergeSide, readonly string[]>;
	base: readonly string[];
}

/** Every edit of Result from a button: one undo step each. */
export function mergeActions(source: () => MergeSource): MergeActions {
	const take = (index: number, sides: readonly EMergeSide[], settle: boolean) =>
		takeSides(source(), index, sides, settle);
	return {
		apply: (index, side) => take(index, [side], false),
		settle: (index, sides) => take(index, sides, true),
		ignore: (index, side) =>
			source().view?.dispatch({
				effects: setChangeState.of({ index, status: { [side]: "ignored" } }),
				annotations: isolateHistory.of("full"),
			}),
		revert: (index, side) => {
			const { view, base } = source();
			const change = view?.state.field(mergeChangesField)[index];
			if (!view || change?.status[side] !== "applied") return;
			const plan = revertPlan(
				view.state.doc,
				change,
				side,
				base.slice(...change.base),
			);
			// A conflict with no side left in is open again: only typing settles it on the base lines.
			const reopen =
				change.conflict &&
				MERGE_SIDES.every(
					(other) => other === side || change.status[other] !== "applied",
				);
			view.dispatch(
				planSpec(
					index,
					plan,
					reopen ? { local: "open", remote: "open" } : { [side]: "ignored" },
				),
			);
		},
	};
}

/**
 * Each step is planned on the document the previous one left, then all go out as one transaction. Settling
 * starts from the base, so the sides land in the order asked whatever was taken before.
 */
function takeSides(
	{ view, sides: lines, base }: MergeSource,
	index: number,
	sides: readonly EMergeSide[],
	settle: boolean,
): void {
	if (!view) return;
	let state: EditorState = view.state;
	let changes = ChangeSet.empty(state.doc.length);
	const step = (
		side: EMergeSide,
		from: readonly ESideStatus[],
		plan: (change: MergeChange) => EditPlan,
		status: ESideStatus,
	) => {
		const change = state.field(mergeChangesField)[index];
		if (!change || !from.includes(change.status[side])) return;
		const tr = state.update(planSpec(index, plan(change), { [side]: status }));
		changes = changes.compose(tr.changes);
		state = tr.state;
	};
	for (const side of settle ? MERGE_SIDES : []) {
		step(
			side,
			["applied"],
			(change) =>
				revertPlan(state.doc, change, side, base.slice(...change.base)),
			"ignored",
		);
	}
	for (const side of sides) {
		step(
			side,
			["open", "ignored"],
			(change) =>
				applyPlan(state.doc, change, side, lines[side].slice(...change[side])),
			"applied",
		);
	}
	const change = state.field(mergeChangesField)[index];
	if (!change) return;
	const dropped: StatusPatch = {};
	for (const side of MERGE_SIDES) {
		if (settle && change.status[side] === "open") dropped[side] = "ignored";
	}
	if (state === view.state && Object.keys(dropped).length === 0) return;
	view.dispatch({
		changes,
		effects: setChangeState.of({
			index,
			result: change.result,
			taken: fullTaken(change.taken),
			status: { ...change.status, ...dropped },
		}),
		annotations: isolateHistory.of("full"),
	});
}

function planSpec(index: number, plan: EditPlan, status: StatusPatch) {
	return {
		changes: { from: plan.from, to: plan.to, insert: plan.insert },
		effects: setChangeState.of({
			index,
			result: plan.result,
			taken: plan.taken,
			status,
		}),
		annotations: isolateHistory.of("full"),
	};
}
