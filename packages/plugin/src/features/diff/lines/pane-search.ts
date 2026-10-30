import {
	closeSearchPanel,
	gotoLine,
	openSearchPanel,
	search,
	searchKeymap,
	searchPanelOpen,
} from "@codemirror/search";
import type { Extension } from "@codemirror/state";
import { EditorView, keymap, ViewPlugin } from "@codemirror/view";
import { appendIconButton } from "@/core/ui";
import { SearchBar } from "./search-bar";

/**
 * A panel's find and go to line, one per pane, toggled from the pane's head, from the toolbar while Inline
 * hides the heads, or by Mod+F. `onOpen` opens what folding hides, or a match could land inside a fold.
 */
export class PanelSearch<K extends string> {
	private readonly views = new Map<K, EditorView>();
	private readonly toggles: { key: K; button: HTMLElement }[] = [];
	private inline: HTMLElement | null = null;

	constructor(
		private readonly main: K,
		private readonly onOpen: (key: K, view: EditorView) => void,
	) {}

	extension(key: K): Extension {
		return [
			search({ createPanel: (view) => new SearchBar(view) }),
			keymap.of([
				// Go to line opens no search panel.
				{
					key: "Mod-Alt-g",
					run: (view) => {
						this.onOpen(key, view);
						return gotoLine(view);
					},
				},
				...searchKeymap,
			]),
			ViewPlugin.define((view) => {
				this.views.set(key, view);
				return { destroy: () => this.views.delete(key) };
			}),
			EditorView.updateListener.of(({ state, startState, view }) => {
				const open = searchPanelOpen(state);
				if (open === searchPanelOpen(startState)) return;
				for (const toggle of this.toggles) {
					if (toggle.key !== key) continue;
					toggle.button.toggleClass("is-active", open);
					toggle.button.setAttr("aria-pressed", String(open));
				}
				// After this update ends: unfolding dispatches.
				if (open) queueMicrotask(() => this.onOpen(key, view));
			}),
		];
	}

	appendToggle(parent: HTMLElement, key: K): HTMLElement {
		const button = appendIconButton(parent, "search", "Search", () =>
			this.toggle(key),
		);
		button.addClass("mdsync-search-toggle");
		button.setAttr("aria-pressed", "false");
		this.toggles.push({ key, button });
		return button;
	}

	appendInlineToggle(toolbar: HTMLElement): void {
		this.inline = this.appendToggle(toolbar, this.main);
	}

	setInline(inline: boolean): void {
		if (this.inline) this.inline.hidden = !inline;
	}

	/** Mod+F: the pane holding the focus, else the main one. */
	toggleFocused(): void {
		const focused = [...this.views].find(([, view]) =>
			view.dom.contains(view.root.activeElement),
		);
		this.toggle(focused?.[0] ?? this.main);
	}

	private toggle(key: K): void {
		const view = this.views.get(key);
		if (!view) return;
		if (!searchPanelOpen(view.state)) {
			openSearchPanel(view);
			return;
		}
		closeSearchPanel(view);
		// A toggle in a head keeps the focus CodeMirror would hand back to the text.
		view.focus();
	}
}
