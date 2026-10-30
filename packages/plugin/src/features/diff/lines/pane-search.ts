import {
	gotoLine,
	openSearchPanel,
	search,
	searchKeymap,
	searchPanelOpen,
} from "@codemirror/search";
import type { Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { appendIconButton } from "@/core/ui";
import { SearchBar } from "./search-bar";

/** Find and go to line in a pane; `onOpen` opens what folding hides, or a match could land inside a fold. */
export function paneSearch(onOpen: () => void): Extension {
	return [
		search({ createPanel: (view) => new SearchBar(view) }),
		keymap.of([
			// Go to line opens no search panel.
			{
				key: "Mod-Alt-g",
				run: (view) => {
					onOpen();
					return gotoLine(view);
				},
			},
			...searchKeymap,
		]),
		EditorView.updateListener.of((update) => {
			if (
				searchPanelOpen(update.state) &&
				!searchPanelOpen(update.startState)
			) {
				// After this update ends: unfolding dispatches.
				queueMicrotask(onOpen);
			}
		}),
	];
}

/** For a phone and anyone who does not know Mod+F: searches the focused pane, else `main`. */
export function appendSearchButton(
	parent: HTMLElement,
	panes: () => readonly (EditorView | null)[],
	main: () => EditorView | null,
): void {
	const button = appendIconButton(parent, "search", "Search", () => {
		const view = panes().find((pane) => pane?.hasFocus) ?? main();
		if (view) openSearchPanel(view);
	});
	// A press would take the focus, and with it which pane to search.
	button.addEventListener("mousedown", (event) => event.preventDefault());
}
