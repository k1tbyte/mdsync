// @vitest-environment jsdom
import {
	closeSearchPanel,
	openSearchPanel,
	searchPanelOpen,
} from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { installElementMethods } from "@tests/helpers/element-methods";
import { installElementFactories } from "@tests/helpers/obsidian-dom";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { PanelSearch } from "@/features/diff/lines/pane-search";

beforeAll(() => {
	installElementFactories();
	installElementMethods();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

type Pane = "left" | "right";

function panel(onOpen: (pane: Pane) => void = () => {}) {
	const search = new PanelSearch<Pane>("right", onOpen);
	const view = (pane: Pane) =>
		new EditorView({
			state: EditorState.create({
				doc: "a\nb",
				extensions: search.extension(pane),
			}),
			parent: document.body,
		});
	const views = { left: view("left"), right: view("right") };
	return {
		search,
		views,
		destroy: () => {
			views.left.destroy();
			views.right.destroy();
		},
	};
}

describe("PanelSearch", () => {
	it("unfolds once each time a pane's search opens", async () => {
		const onOpen = vi.fn();
		const { views, destroy } = panel(onOpen);

		openSearchPanel(views.left);
		openSearchPanel(views.left);
		await settle();
		expect(onOpen).toHaveBeenCalledTimes(1);
		expect(onOpen).toHaveBeenCalledWith("left", views.left);

		closeSearchPanel(views.left);
		openSearchPanel(views.left);
		await settle();
		expect(onOpen).toHaveBeenCalledTimes(2);
		destroy();
	});

	it("unfolds before Go to line, which opens no search panel", () => {
		const onOpen = vi.fn();
		const { views, destroy } = panel(onOpen);
		views.right.contentDOM.dispatchEvent(
			new KeyboardEvent("keydown", { key: "g", ctrlKey: true, altKey: true }),
		);
		expect(onOpen).toHaveBeenCalledWith("right", views.right);
		destroy();
	});

	it("toggles a pane's search from its head, pressed while open however it opened", () => {
		const { search, views, destroy } = panel();
		const head = document.body.createDiv();
		search.appendToggle(head, "left");
		const toggle = head.querySelector("button") as HTMLButtonElement;

		toggle.click();
		expect(searchPanelOpen(views.left.state)).toBe(true);
		expect(searchPanelOpen(views.right.state)).toBe(false);
		expect(toggle.getAttribute("aria-pressed")).toBe("true");

		toggle.focus();
		toggle.click();
		expect(searchPanelOpen(views.left.state)).toBe(false);
		expect(toggle.classList.contains("is-active")).toBe(false);
		expect(views.left.hasFocus).toBe(true);

		openSearchPanel(views.left);
		expect(toggle.classList.contains("is-active")).toBe(true);
		destroy();
	});

	it("shows the toolbar's toggle only Inline, for the main pane", () => {
		const { search, views, destroy } = panel();
		const toolbar = document.createElement("div");
		search.appendInlineToggle(toolbar);
		const toggle = toolbar.querySelector("button") as HTMLButtonElement;
		search.setInline(false);
		expect(toggle.hidden).toBe(true);
		search.setInline(true);
		expect(toggle.hidden).toBe(false);

		toggle.click();
		expect(searchPanelOpen(views.right.state)).toBe(true);
		destroy();
	});

	it("toggles the focused pane's search on Mod+F, else the main pane's", () => {
		const { search, views, destroy } = panel();
		search.toggleFocused();
		expect(searchPanelOpen(views.right.state)).toBe(true);
		search.toggleFocused();
		expect(searchPanelOpen(views.right.state)).toBe(false);

		views.left.contentDOM.focus();
		search.toggleFocused();
		expect(searchPanelOpen(views.left.state)).toBe(true);
		// The focus is in the left pane's bar now: Mod+F there closes it.
		search.toggleFocused();
		expect(searchPanelOpen(views.left.state)).toBe(false);
		destroy();
	});
});
