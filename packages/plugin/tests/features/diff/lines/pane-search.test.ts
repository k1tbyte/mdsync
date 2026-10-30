// @vitest-environment jsdom
import { closeSearchPanel, openSearchPanel } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { installElementMethods } from "@tests/helpers/element-methods";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	appendSearchButton,
	paneSearch,
} from "@/features/diff/lines/pane-search";

beforeAll(installElementMethods);

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("paneSearch", () => {
	it("unfolds once each time the search panel opens", async () => {
		const onOpen = vi.fn();
		const view = paneView(onOpen);

		openSearchPanel(view);
		openSearchPanel(view);
		await settle();
		expect(onOpen).toHaveBeenCalledTimes(1);

		closeSearchPanel(view);
		openSearchPanel(view);
		await settle();
		expect(onOpen).toHaveBeenCalledTimes(2);
		view.destroy();
	});

	it("unfolds before Go to line, which opens no search panel", () => {
		const onOpen = vi.fn();
		const view = paneView(onOpen);
		view.contentDOM.dispatchEvent(
			new KeyboardEvent("keydown", { key: "g", ctrlKey: true, altKey: true }),
		);
		expect(onOpen).toHaveBeenCalledTimes(1);
		view.destroy();
	});
});

describe("appendSearchButton", () => {
	it("keeps the focus where it is on a press, so the focused pane is searched", () => {
		const toolbar = document.createElement("div");
		appendSearchButton(
			toolbar,
			() => [],
			() => null,
		);
		const press = new MouseEvent("mousedown", { cancelable: true });
		toolbar.querySelector("button")?.dispatchEvent(press);
		expect(press.defaultPrevented).toBe(true);
	});
});

function paneView(onOpen: () => void): EditorView {
	return new EditorView({
		state: EditorState.create({
			doc: "a\nb",
			extensions: paneSearch(onOpen),
		}),
		parent: document.body,
	});
}
