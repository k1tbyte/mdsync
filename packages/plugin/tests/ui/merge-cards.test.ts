import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { buildMergeSession } from "@/sync/merge-model";
import { mergeActions } from "@/ui/diff/merge-actions";
import { type CombinedMergeConfig, mergeCards } from "@/ui/diff/merge-cards";
import { mergeResultState } from "@/ui/diff/merge-decorations";
import { sideMarks } from "@/ui/diff/merge-marks";
import { initialMergeChanges } from "@/ui/diff/merge-state";
import type { SourceBlock } from "@/ui/diff/source-widget";

function open(base: string, local: string, remote: string) {
	const session = buildMergeSession(base, local, remote);
	const sides = { local: session.localLines, remote: session.remoteLines };
	let state: EditorState;
	const view = {
		get state() {
			return state;
		},
		dispatch: (spec: Parameters<EditorState["update"]>[0]) => {
			state = state.update(spec).state;
		},
	} as unknown as EditorView;
	const config: CombinedMergeConfig = {
		actions: mergeActions(() => ({ view, sides, base: session.baseLines })),
		base: session.baseLines,
		sides,
		marks: sideMarks(session.baseLines, sides),
		toggleGap: () => {},
	};
	state = EditorState.create({
		doc: session.text,
		extensions: [
			initialMergeChanges.of(session.changes),
			mergeResultState(config),
		],
	});
	/** The cards' blocks in the order they are drawn. */
	const blocks = (): SourceBlock[] => {
		const out: SourceBlock[] = [];
		mergeCards(config)(state).between(
			0,
			state.doc.length,
			(_from, _to, deco) => {
				const widget = deco.spec.widget as { block?: SourceBlock } | undefined;
				if (widget?.block) out.push(widget.block);
			},
		);
		return out;
	};
	return {
		view,
		actions: config.actions,
		blocks,
		heads: () => blocks().map((block) => block.head.text),
	};
}

describe("merge cards", () => {
	it("keeps a conflict's choices above the next card where the two meet", () => {
		const merge = open("a\nx\nb\n", "L\nx\nM\n", "R\nx\nN\n");
		merge.view.dispatch({ changes: { from: 2, to: 4 } });
		expect(merge.blocks().map((block) => block.key)).toEqual([
			"card-0",
			"foot-0",
			"card-1",
			"foot-1",
		]);
	});

	it("tells a change typed by hand from one left out", () => {
		const merge = open("a\nb\nc", "a\nb\nc", "a\nR\nc");
		expect(merge.heads()).toEqual(["Line 2 · from Remote"]);
		merge.actions.settle(0, []);
		expect(merge.heads()).toEqual(["Line 2 · Remote left out"]);
		merge.view.dispatch({ changes: { from: 2, to: 3, insert: "custom" } });
		expect(merge.heads()).toEqual(["Line 2 · edited by hand"]);
	});
});
