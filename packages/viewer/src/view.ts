import { addAnchors, currentAnchor } from "./anchors";
import { addCopyButtons } from "./code";
import { createOutline } from "./outline";
import { sanitizeNote } from "./sanitize";
import { foldSections } from "./sections";
import type { ViewState } from "./session";
import { createSidebar } from "./sidebar";

export interface View {
	show(state: ViewState): void;
}

export interface ViewHandlers {
	onPassphrase(passphrase: string, remember: boolean): void;
}

type Child = Node | string;

export function createView(root: HTMLElement, handlers: ViewHandlers): View {
	const doc = root.ownerDocument;

	function el<K extends keyof HTMLElementTagNameMap>(
		tag: K,
		attrs: Record<string, string> = {},
		...children: Child[]
	): HTMLElementTagNameMap[K] {
		const node = doc.createElement(tag);
		for (const [name, value] of Object.entries(attrs))
			node.setAttribute(name, value);
		node.append(...children);
		return node;
	}

	const message = (title: string, text: string, ...extra: Node[]) =>
		el(
			"section",
			{ class: "message" },
			el("h1", {}, title),
			el("p", {}, text),
			...extra,
		);

	// A wrong passphrase draws the form again: the reader's choice must survive it.
	let rememberChoice = false;

	function passphraseForm(problem?: string): HTMLElement {
		const input = el("input", {
			type: "password",
			id: "passphrase",
			autocomplete: "off",
			autocapitalize: "off",
			spellcheck: "false",
			required: "",
		});
		const remember = el("input", { type: "checkbox" });
		remember.checked = rememberChoice;
		const form = el(
			"form",
			{ class: "passphrase" },
			el("h1", {}, "This note is protected"),
			el("label", { for: "passphrase" }, "Passphrase"),
			input,
			el("label", { class: "remember" }, remember, "Remember on this browser"),
			el("p", { class: "problem", role: "alert" }, problem ?? ""),
			el("button", { type: "submit" }, "Open"),
		);
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			rememberChoice = remember.checked;
			handlers.onPassphrase(input.value, rememberChoice);
		});
		queueMicrotask(() => input.focus());
		return form;
	}

	function content(
		state: Extract<ViewState, { kind: "content" }>,
		signal: AbortSignal,
	): HTMLElement {
		const { title } = state.payload;
		const body = el("div", { class: "markdown-rendered" });
		body.append(sanitizeNote(state.payload.html));
		const first = body.firstElementChild;
		// A note that opens with its own name as H1 would show it twice.
		const named =
			first?.tagName === "H1" && first.textContent?.trim() === title;
		addCopyButtons(body);
		const headings = foldSections(body);
		const outline = createOutline(headings, signal);
		const jump = addAnchors(body, headings);
		// Jumps once laid out, and again when the address names another anchor.
		requestAnimationFrame(() => jump(currentAnchor()));
		window.addEventListener("hashchange", () => jump(currentAnchor()), {
			signal,
		});
		body.addEventListener("click", (event) => {
			const target = event.target as Element;
			const title = target.closest(".callout-title");
			const callout = title?.closest(".callout.is-collapsible");
			callout?.classList.toggle("is-collapsed");
		});
		doc.title = title || "Shared note";
		const article = el(
			"article",
			{ class: "note" },
			title && !named ? el("h1", { class: "note-title" }, title) : "",
			body,
		);
		const reader = el("div", { class: "reader" }, article);
		reader.prepend(createSidebar(reader, outline, state, signal));
		return reader;
	}

	function render(state: ViewState, signal: AbortSignal): HTMLElement {
		switch (state.kind) {
			case "loading":
				return el("p", { class: "loading" }, "Opening…");
			case "passphrase":
				return passphraseForm(state.problem);
			case "content":
				return content(state, signal);
			case "gone":
				return message(
					"This link is no longer available",
					"It has expired, reached its view limit or was removed by its owner.",
				);
			case "invalid":
				return message(
					"This link is incomplete",
					"The address is missing its key. Ask the sender for the whole link.",
				);
			case "error":
				return message("This note could not be opened", state.message);
		}
	}

	let shown = new AbortController();
	return {
		show(state) {
			shown.abort();
			shown = new AbortController();
			root.replaceChildren(render(state, shown.signal));
		},
	};
}
