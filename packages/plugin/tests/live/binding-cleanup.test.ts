import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { forgetView } from "@/live/text/binding";

describe("forgetView", () => {
	it("drops one view's selections from both stacks and keeps the history", () => {
		const doc = new Y.Doc();
		const text = doc.getText("t");
		const undoManager = new Y.UndoManager(text, {
			captureTimeout: 0,
			trackedOrigins: new Set(["me"]),
		});
		const closed = {} as EditorView;
		const open = {} as EditorView;
		const closedPlugin = { view: closed };
		const openPlugin = { view: open };
		doc.transact(() => text.insert(0, "a"), "me");
		doc.transact(() => text.insert(1, "b"), "me");
		undoManager.undo();
		for (const item of [...undoManager.undoStack, ...undoManager.redoStack]) {
			item.meta.set(closedPlugin, "sel");
			item.meta.set(openPlugin, "sel");
		}

		forgetView(undoManager, closed);

		const items = [...undoManager.undoStack, ...undoManager.redoStack];
		expect(items).toHaveLength(2);
		for (const item of items) {
			expect(item.meta.has(closedPlugin)).toBe(false);
			expect(item.meta.get(openPlugin)).toBe("sel");
		}
		expect(text.toString()).toBe("a");
		undoManager.undo();
		expect(text.toString()).toBe("");
	});
});
