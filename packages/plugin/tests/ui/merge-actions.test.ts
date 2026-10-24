import { history, undo } from "@codemirror/commands";
import {
	EditorState,
	type Transaction,
	type TransactionSpec,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { buildMergeSession } from "@/sync/merge-model";
import { mergeActions } from "@/ui/diff/merge-actions";
import { mergeResultState } from "@/ui/diff/merge-decorations";
import { initialMergeChanges, mergeChangesField } from "@/ui/diff/merge-state";

/** A Result editor without a DOM: the actions only read its state and dispatch. */
function open(base: string, local: string, remote: string) {
	const session = buildMergeSession(base, local, remote);
	let state = EditorState.create({
		doc: session.text,
		extensions: [
			initialMergeChanges.of(session.changes),
			mergeResultState(),
			history(),
		],
	});
	const view = {
		get state() {
			return state;
		},
		dispatch: (spec: TransactionSpec) => {
			state = state.update(spec).state;
		},
	} as unknown as EditorView;
	const actions = mergeActions(() => ({
		view,
		sides: { local: session.localLines, remote: session.remoteLines },
		base: session.baseLines,
	}));
	const undoOnce = () =>
		undo({
			state,
			dispatch: (tr: Transaction) => {
				state = tr.state;
			},
		});
	return {
		actions,
		undoOnce,
		text: () => state.doc.toString(),
		status: () => state.field(mergeChangesField)[0]?.status,
	};
}

describe("settling a conflict", () => {
	it("takes both sides in the order asked, undone in one step", () => {
		const merge = open("a\nb\nc", "a\nL\nc", "a\nR\nc");
		merge.actions.settle(0, ["local", "remote"]);
		expect(merge.text()).toBe("a\nL\nR\nc");
		expect(merge.status()).toEqual({ local: "applied", remote: "applied" });
		merge.undoOnce();
		expect(merge.text()).toBe("a\nb\nc");
		expect(merge.status()).toEqual({ local: "open", remote: "open" });
	});

	it("drops the other side, so the conflict is resolved", () => {
		const merge = open("a\nb\nc", "a\nL\nc", "a\nR\nc");
		merge.actions.settle(0, ["local"]);
		expect(merge.text()).toBe("a\nL\nc");
		expect(merge.status()).toEqual({ local: "applied", remote: "ignored" });
	});

	it("is open again once its last taken side is rejected", () => {
		const merge = open("a\nb\nc", "a\nL\nc", "a\nR\nc");
		merge.actions.settle(0, ["local", "remote"]);
		merge.actions.revert(0, "local");
		expect(merge.status()).toEqual({ local: "ignored", remote: "applied" });
		merge.actions.revert(0, "remote");
		expect(merge.text()).toBe("a\nb\nc");
		expect(merge.status()).toEqual({ local: "open", remote: "open" });
	});

	it.each([
		["a", "local", "remote"],
		["a", "remote", "local"],
		["a\n", "local", "remote"],
		["a\n", "remote", "local"],
	] as const)(
		"restores the base of a conflict at the end once both sides are rejected (local %j, %s first)",
		(local, first, second) => {
			const merge = open("a\nb", local, "a\nR");
			merge.actions.settle(0, ["local", "remote"]);
			expect(merge.text()).toBe(`${local}\nR`);
			merge.actions.revert(0, first);
			merge.actions.revert(0, second);
			expect(merge.text()).toBe("a\nb");
		},
	);

	it("replaces a side taken before rather than stacking on it", () => {
		const merge = open("a\nb\nc", "a\nL\nc", "a\nR\nc");
		merge.actions.apply(0, "local");
		merge.actions.settle(0, ["remote"]);
		expect(merge.text()).toBe("a\nR\nc");
		expect(merge.status()).toEqual({ local: "ignored", remote: "applied" });
		merge.undoOnce();
		expect(merge.text()).toBe("a\nL\nc");
		expect(merge.status()).toEqual({ local: "applied", remote: "open" });
	});
});
