import {
	findNext,
	findPrevious,
	getSearchQuery,
	replaceAll,
	replaceNext,
	SearchQuery,
	setSearchQuery,
} from "@codemirror/search";
import {
	type EditorView,
	type Panel,
	runScopeHandlers,
	type ViewUpdate,
} from "@codemirror/view";
import { SearchComponent, TextComponent } from "obsidian";
import { appendIconButton, appendLabeledButton } from "@/core/ui";

/** Counted on every edit while open: past this the count says "+". */
const COUNT_MAX = 1000;

type Flag = "caseSensitive" | "wholeWord" | "regexp";

const FLAGS: readonly { flag: Flag; icon: string; label: string }[] = [
	{ flag: "caseSensitive", icon: "case-sensitive", label: "Match case" },
	{ flag: "wholeWord", icon: "whole-word", label: "Match whole word" },
	{ flag: "regexp", icon: "regex", label: "Use regular expression" },
];

/** CodeMirror's search in Obsidian's look: its query, matching and commands, our bar. Replace only where the pane is editable; closed by its toggle, Mod+F or Escape. */
export class SearchBar implements Panel {
	readonly dom = createDiv({ cls: "mdsync-search-bar" });
	readonly top = true;
	private query: SearchQuery;
	private readonly find: SearchComponent;
	private readonly replace: TextComponent | null = null;
	private readonly count: HTMLElement;
	private readonly flags: { flag: Flag; button: HTMLButtonElement }[];

	constructor(private readonly view: EditorView) {
		this.query = getSearchQuery(view.state);
		const row = this.dom.createDiv({ cls: "mdsync-search-row" });
		this.find = new SearchComponent(
			row.createDiv({ cls: "mdsync-search-field" }),
		)
			.setPlaceholder("Find")
			.onChange(() => this.commit({}));
		// `openSearchPanel` focuses and selects the field marked so.
		this.find.inputEl.setAttr("main-field", "true");
		this.find.inputEl.setAttr("aria-label", "Find");
		// Inside the field, before Obsidian's clear button.
		this.count = createSpan({ cls: "mdsync-search-count" });
		this.find.inputEl.after(this.count);
		// One block, so a narrow pane wraps every button together.
		const tools = row.createDiv({ cls: "mdsync-search-tools" });
		appendIconButton(tools, "arrow-up", "Previous match", () =>
			findPrevious(view),
		);
		appendIconButton(tools, "arrow-down", "Next match", () => findNext(view));
		this.flags = FLAGS.map(({ flag, icon, label }) => ({
			flag,
			button: appendIconButton(tools, icon, label, () =>
				this.commit({ [flag]: !this.query[flag] }),
			),
		}));
		if (!view.state.readOnly) this.replace = this.renderReplace(tools);
		this.dom.addEventListener("keydown", (event) => this.onKey(event));
		this.show();
	}

	/** The first open focuses here; `openSearchPanel` refocuses only an open bar. */
	mount(): void {
		this.find.inputEl.focus();
		this.find.inputEl.select();
	}

	update(update: ViewUpdate): void {
		const query = getSearchQuery(update.state);
		const changed = !query.eq(this.query);
		if (changed) {
			this.query = query;
			this.show();
		} else if (update.docChanged || update.selectionSet) {
			this.recount();
		}
	}

	private renderReplace(tools: HTMLElement): TextComponent {
		const line = this.dom.createDiv({ cls: "mdsync-search-row" });
		line.hidden = true;
		const replace = new TextComponent(
			line.createDiv({ cls: "mdsync-search-field" }),
		)
			.setPlaceholder("Replace")
			.onChange(() => this.commit({}));
		replace.inputEl.setAttr("aria-label", "Replace");
		appendLabeledButton(line, "replace", "Replace", () =>
			replaceNext(this.view),
		);
		appendLabeledButton(line, "replace-all", "Replace all", () =>
			replaceAll(this.view),
		);
		const toggle = appendIconButton(tools, "replace", "Show replace", () => {
			line.hidden = !line.hidden;
			toggle.toggleClass("is-active", !line.hidden);
			toggle.setAttr("aria-pressed", String(!line.hidden));
			if (!line.hidden) replace.inputEl.focus();
		});
		return replace;
	}

	/** The scoped search keys (Esc, F3) first; Enter in a field steps, or replaces in the replace field. Buttons keep their own Enter. */
	private onKey(event: KeyboardEvent): void {
		if (runScopeHandlers(this.view, event, "search-panel")) {
			event.preventDefault();
			return;
		}
		if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement))
			return;
		event.preventDefault();
		if (event.target === this.replace?.inputEl) replaceNext(this.view);
		else if (event.shiftKey) findPrevious(this.view);
		else findNext(this.view);
	}

	private commit(flags: Partial<Record<Flag, boolean>>): void {
		const { query } = this;
		const next = new SearchQuery({
			search: this.find.getValue(),
			replace: this.replace?.getValue() ?? query.replace,
			literal: query.literal,
			caseSensitive: flags.caseSensitive ?? query.caseSensitive,
			wholeWord: flags.wholeWord ?? query.wholeWord,
			regexp: flags.regexp ?? query.regexp,
		});
		if (!next.eq(query))
			this.view.dispatch({ effects: setSearchQuery.of(next) });
	}

	/** A query set elsewhere (opening on a selection) shows here; the field being typed in keeps its caret. */
	private show(): void {
		const { query } = this;
		if (this.find.getValue() !== query.search) this.find.setValue(query.search);
		if (this.replace && this.replace.getValue() !== query.replace) {
			this.replace.setValue(query.replace);
		}
		for (const { flag, button } of this.flags) {
			button.toggleClass("is-active", query[flag]);
			button.setAttr("aria-pressed", String(query[flag]));
		}
		this.recount();
	}

	private recount(): void {
		const [text, missing] = this.matches();
		this.count.setText(text);
		this.count.toggleClass("is-empty", missing);
	}

	/** The count's text, and whether nothing matches; an invalid pattern matches nothing. */
	private matches(): [string, boolean] {
		const { query } = this;
		if (!query.search) return ["", false];
		if (!query.valid) return ["0", true];
		const { from, to } = this.view.state.selection.main;
		const cursor = query.getCursor(this.view.state);
		let total = 0;
		let current = 0;
		for (let next = cursor.next(); !next.done; next = cursor.next()) {
			total++;
			if (next.value.from === from && next.value.to === to) current = total;
			if (total === COUNT_MAX) break;
		}
		if (total === 0) return ["0", true];
		const all = `${total}${total === COUNT_MAX ? "+" : ""}`;
		return [current > 0 ? `${current}/${all}` : all, false];
	}
}
