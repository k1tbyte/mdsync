// @vitest-environment jsdom
import type { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { installDismissHandlers } from "@/editor/signs/popup-dismiss";

describe("installDismissHandlers", () => {
	it("listens in the editor's own window, a popout included", () => {
		const popout = document.implementation.createHTMLDocument("popout");
		const editor = popout.body.appendChild(popout.createElement("div"));
		const popup = popout.body.appendChild(popout.createElement("div"));
		const view = { dom: editor, scrollDOM: editor } as unknown as EditorView;
		const dismiss = vi.fn();

		const cleanup = installDismissHandlers(view, popup, dismiss);
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		expect(dismiss).not.toHaveBeenCalled();
		popout.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		expect(dismiss).toHaveBeenCalledOnce();

		cleanup();
		popout.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		expect(dismiss).toHaveBeenCalledOnce();
	});
});
