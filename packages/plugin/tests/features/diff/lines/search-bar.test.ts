// @vitest-environment jsdom
import {
	getSearchQuery,
	openSearchPanel,
	searchPanelOpen,
} from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { installElementMethods } from "@tests/helpers/element-methods";
import { installElementFactories } from "@tests/helpers/obsidian-dom";
import { beforeAll, describe, expect, it } from "vitest";
import { PanelSearch } from "@/features/diff/lines/pane-search";

beforeAll(() => {
	installElementFactories();
	installElementMethods();
});

function openBar(doc: string, editable = false, select?: [number, number]) {
	const view = new EditorView({
		state: EditorState.create({
			doc,
			extensions: [
				new PanelSearch("pane", () => {}).extension("pane"),
				EditorState.readOnly.of(!editable),
			],
		}),
		parent: document.body,
	});
	if (select)
		view.dispatch({ selection: { anchor: select[0], head: select[1] } });
	openSearchPanel(view);
	const bar = view.dom.querySelector(".cm-panels-top .mdsync-search-bar");
	if (!(bar instanceof HTMLElement)) throw new Error("no search bar");
	const field = (label: string) =>
		bar.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
	const button = (label: string) =>
		bar.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
	return {
		view,
		field,
		button,
		labeled: (text: string) =>
			[...bar.querySelectorAll("button")].find((b) => b.textContent === text),
		type(label: string, text: string) {
			field(label).value = text;
			field(label).dispatchEvent(new Event("input"));
		},
		press(key: string, shiftKey = false) {
			field("Find").dispatchEvent(
				new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }),
			);
		},
		count: () => bar.querySelector(".mdsync-search-count")?.textContent,
	};
}

describe("SearchBar", () => {
	it("sets CodeMirror's query, counts and steps through matches", () => {
		const bar = openBar("Apple and apple\napple pie");
		bar.type("Find", "apple");
		expect(getSearchQuery(bar.view.state).search).toBe("apple");
		expect(bar.count()).toBe("3");

		bar.press("Enter");
		expect(bar.count()).toBe("1/3");
		bar.press("Enter", true);
		expect(bar.count()).toBe("3/3");

		bar.button("Match case")?.click();
		expect(getSearchQuery(bar.view.state).caseSensitive).toBe(true);
		expect(bar.button("Match case")?.classList.contains("is-active")).toBe(
			true,
		);
		expect(bar.count()).toBe("2/2");

		bar.type("Find", "pear");
		expect(bar.count()).toBe("0");
		bar.view.destroy();
	});

	it("shows a query taken from the selection", () => {
		const bar = openBar("Apple and apple", false, [6, 9]);
		expect(bar.field("Find").value).toBe("and");
		bar.view.destroy();
	});

	it("offers replace only where the pane can be edited", () => {
		const readOnly = openBar("cat cat");
		expect(readOnly.button("Show replace")).toBeNull();
		readOnly.view.destroy();

		const bar = openBar("cat cat", true);
		bar.button("Show replace")?.click();
		bar.type("Find", "cat");
		bar.type("Replace", "dog");
		bar.labeled("Replace all")?.click();
		expect(bar.view.state.doc.toString()).toBe("dog dog");
		bar.view.destroy();
	});

	it("focuses Find when it opens", () => {
		const bar = openBar("cat", true);
		expect(document.activeElement).toBe(bar.field("Find"));
		bar.view.destroy();
	});

	it("leaves Enter on a button to the button", () => {
		const bar = openBar("cat cat");
		bar.type("Find", "cat");
		bar
			.button("Match case")
			?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
			);
		expect(bar.count()).toBe("2");
		bar.view.destroy();
	});

	it("closes on Escape through CodeMirror's search keys", () => {
		const bar = openBar("cat");
		bar.press("Escape");
		expect(searchPanelOpen(bar.view.state)).toBe(false);
		bar.view.destroy();
	});
});
