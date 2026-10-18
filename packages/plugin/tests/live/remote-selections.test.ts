// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { remoteSelections } from "@/live/text/remote-selections";

const FRIEND = 999;

function editor(content: string, hidden?: { from: number; to: number }) {
	const doc = new Y.Doc();
	const text = doc.getText("body");
	text.insert(0, content);
	const awareness = new Awareness(doc);
	const plugin = remoteSelections(text, awareness);
	const folds = hidden
		? EditorView.decorations.of(
				Decoration.set(Decoration.replace({}).range(hidden.from, hidden.to)),
			)
		: [];
	const view = new EditorView({
		state: EditorState.create({ doc: content, extensions: [plugin, folds] }),
		parent: document.body,
	});
	const select = (anchor: number, head: number) => {
		const at = (index: number) =>
			Y.relativePositionToJSON(
				Y.createRelativePositionFromTypeIndex(text, index),
			);
		awareness.states.set(FRIEND, {
			user: { name: "Friend", color: "#f00" },
			cursor: { anchor: at(anchor), head: at(head) },
		});
		awareness.emit("change", [
			{ added: [FRIEND], updated: [], removed: [] },
			"remote",
		]);
	};
	const marks = () => {
		const out: [number, number, string][] = [];
		view
			.plugin(plugin)
			?.decorations.between(0, content.length, (from, to, deco) => {
				const cls = deco.spec.class ?? deco.spec.attributes?.class;
				if (cls) out.push([from, to, cls]);
			});
		return out;
	};
	return { view, select, marks };
}

describe("remote selections", () => {
	it("draw a remote caret under its name", () => {
		const { view, select } = editor("hello world\n");
		select(3, 3);

		expect(
			view.contentDOM.querySelector(".cm-ySelectionInfo")?.textContent,
		).toBe("Friend");
	});

	it("mark a line split by a fold once, only where it shows", () => {
		// CodeMirror splits the visible ranges only at a fold of 20 characters or more.
		const content = `aaaa\n${"b".repeat(40)}\ncccc\n`;
		const { select, marks } = editor(content, { from: 8, to: 38 });
		select(2, 48);

		expect(marks()).toEqual([
			[2, 4, "cm-ySelection"],
			[5, 5, "cm-yLineSelection"],
			[46, 48, "cm-ySelection"],
		]);

		select(7, 48);
		expect(marks()).toEqual([
			[7, 8, "cm-ySelection"],
			[38, 45, "cm-ySelection"],
			[46, 48, "cm-ySelection"],
		]);
	});
});
