import { EditorView } from "@codemirror/view";
import { headlessEditor } from "@tests/helpers/headless-editor";
import {
	converge,
	type Device,
	type,
	useLiveRoom,
} from "@tests/helpers/live-session";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ySyncFacet } from "y-codemirror.next";

import type { BoundEditor } from "@/live/model";
import { authorMarks } from "@/live/text/author-marks";
import { bindEditor } from "@/live/text/binding";

vi.mock("@/live/text/author-marks", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/live/text/author-marks")>();
	return { authorMarks: vi.fn(actual.authorMarks) };
});

const live = useLiveRoom();

afterEach(() => {
	vi.restoreAllMocks();
	vi.mocked(authorMarks).mockClear();
});

function bind(device: Device, editorText: string, me: string | null = "me") {
	const opened = headlessEditor(editorText);
	const ownUndo = opened.editor.undo;
	const bound = bindEditor(opened.view, device.session, me) as BoundEditor;
	return { ...opened, ownUndo, bound };
}

function typeInView(
	device: Device,
	{ cm }: ReturnType<typeof headlessEditor>,
	at: number,
	text: string,
): void {
	const { model, doc } = device.session;
	const typing = cm.state.facet(ySyncFacet);
	model.undoManager.addTrackedOrigin(typing);
	doc.transact(() => model.text.insert(at, text), typing);
}

describe("binding an editor to a live room", () => {
	it("does nothing when Obsidian gives no CodeMirror", async () => {
		const a = await live.synced("hello");
		const editor = { getValue: vi.fn(), setValue: vi.fn() };

		const bound = bindEditor({ editor } as never, a.session, "me");

		expect(bound).toBeNull();
		expect(editor.getValue).not.toHaveBeenCalled();
	});

	it("shows the room's text in an editor that lags it, and leaves one that has it alone", async () => {
		const a = await live.synced("hello");
		type(a, 5, " world");
		const b = await live.synced("hello");
		await converge("hello world", a, b);

		const lagging = bind(b, "hello");
		const current = bind(b, "hello world");

		expect(lagging.editor.setValue).toHaveBeenCalledExactlyOnceWith(
			"hello world",
		);
		expect(current.editor.setValue).not.toHaveBeenCalled();
	});

	it("carries what was typed while the room was answering into the room", async () => {
		const a = await live.synced("hello");
		const b = await live.synced("hello");

		const typed = bind(b, "hello!");

		expect(typed.editor.setValue).not.toHaveBeenCalled();
		await converge("hello!", a, b);
	});

	it("attaches the room's own text to the editor, and detach takes it off without touching either text", async () => {
		const a = await live.synced("hello");
		const { cm, editor, bound } = bind(a, "hello");
		expect(cm.state.facet(ySyncFacet)?.ytext).toBe(a.session.model.text);

		bound.detach();
		bound.detach();

		expect(cm.state.facet(ySyncFacet)).toBeUndefined();
		expect(cm.state.doc.toString()).toBe("hello");
		expect(editor.getValue()).toBe("hello");
		expect(a.session.model.text.toString()).toBe("hello");
	});

	it("routes the phone toolbar's undo to the room and takes back only this device's typing", async () => {
		const a = await live.synced("hello");
		const b = await live.synced("hello");
		const opened = bind(b, "hello");
		type(a, 0, ">>");
		await converge(">>hello", a, b);
		typeInView(b, opened, 7, "!");
		expect(b.session.model.text.toString()).toBe(">>hello!");

		opened.editor.undo();

		expect(b.session.model.text.toString()).toBe(">>hello");
		expect(opened.ownUndo).not.toHaveBeenCalled();
		opened.editor.redo();
		expect(b.session.model.text.toString()).toBe(">>hello!");
		opened.bound.detach();
		expect(opened.editor.undo).toBe(opened.ownUndo);
	});

	it("gives the editor its own undo back once every binding let go, whichever detached first", async () => {
		const a = await live.synced("hello");
		const opened = bind(a, "hello");
		const again = bindEditor(opened.view, a.session, "me") as BoundEditor;

		opened.bound.detach();
		again.detach();

		expect(opened.editor.undo).toBe(opened.ownUndo);
	});

	it("survives a leaf that was torn down before its binding", async () => {
		const a = await live.synced("hello");
		const { cm, bound } = bind(a, "hello");
		cm.dispatch.mockImplementation(() => {
			throw new Error("view destroyed");
		});

		expect(() => bound.showAuthors(null)).not.toThrow();
		expect(() => bound.detach()).not.toThrow();
	});

	it("undoes through the room when the Edit menu or a system gesture asks CodeMirror to", async () => {
		const domEventHandlers = vi.spyOn(EditorView, "domEventHandlers");
		const a = await live.synced("hello");
		const opened = bind(a, "hello");
		const [{ beforeinput }] = domEventHandlers.mock.calls.at(-1) as unknown as [
			{ beforeinput: (event: object, view: object) => boolean },
		];
		typeInView(a, opened, 5, "!");
		const undo = { inputType: "historyUndo", preventDefault: vi.fn() };
		const typing = { inputType: "insertText", preventDefault: vi.fn() };

		expect(beforeinput(typing, {})).toBe(false);
		expect(typing.preventDefault).not.toHaveBeenCalled();
		expect(a.session.model.text.toString()).toBe("hello!");
		expect(beforeinput(undo, {})).toBe(true);

		expect(undo.preventDefault).toHaveBeenCalled();
		expect(a.session.model.text.toString()).toBe("hello");
	});

	it("tints others' text only while authors are shown", async () => {
		const a = await live.synced("hello");

		const hidden = bind(a, "hello", null);
		expect(authorMarks).not.toHaveBeenCalled();
		hidden.bound.showAuthors("ann");
		expect(authorMarks).toHaveBeenCalledOnce();
		expect(vi.mocked(authorMarks).mock.calls[0]?.[2]).toBe("ann");
		hidden.bound.showAuthors(null);
		expect(authorMarks).toHaveBeenCalledOnce();

		bind(a, "hello", "bob");
		expect(authorMarks).toHaveBeenCalledTimes(2);
	});
});
