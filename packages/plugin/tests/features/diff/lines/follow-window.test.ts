// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { followWindow } from "@/features/diff/lines/follow-window";

describe("followWindow", () => {
	it("mounts the editor in the document its host moved to", () => {
		const host = document.body.appendChild(document.createElement("div"));
		let migrate = () => {};
		Object.assign(host, {
			doc: document,
			onWindowMigrated: (listener: () => void) => {
				migrate = listener;
				return () => {};
			},
		});
		const view = new EditorView({
			state: EditorState.create({ extensions: followWindow(host) }),
			parent: host,
		});
		const popout = document.implementation.createHTMLDocument();
		Object.assign(host, { doc: popout });
		migrate();
		expect(view.root).toBe(popout);
		view.destroy();
	});
});
