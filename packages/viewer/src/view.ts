import { addAnchors, currentAnchor } from "./anchors";
import { addCopyButtons } from "./code";
import { el as create } from "./dom";
import { factChips } from "./facts";
import { credit, type IconName, icon, tile } from "./icons";
import { markLoneImages } from "./images";
import { noteMarkdown } from "./markdown";
import { createOutline } from "./outline";
import { sanitizeNote } from "./sanitize";
import { foldSections } from "./sections";
import type { ViewState } from "./session";
import { createSidebar } from "./sidebar";
import { createTopbar } from "./topbar";

export interface View {
	show: (state: ViewState) => void;
}

export interface ViewHandlers {
	onPassphrase: (passphrase: string, remember: boolean) => void;
}

export function createView(root: HTMLElement, handlers: ViewHandlers): View {
	const doc = root.ownerDocument;

	const el = <K extends keyof HTMLElementTagNameMap>(
		tag: K,
		attrs: Record<string, string> = {},
		...children: (Node | string)[]
	) => create(doc, tag, attrs, ...children);

	/** A page before any note: its content centred, the credit at the foot. */
	const gate = (...children: Node[]) =>
		el("div", { class: "gate" }, ...children, credit(doc));

	const message = (tone: string, name: IconName, title: string, text: string) =>
		gate(
			el(
				"section",
				{ class: "message" },
				tile(doc, `is-${tone}`, name),
				el("h1", {}, title),
				el("p", {}, text),
			),
		);

	/** The page's frame in grey while the relay answers. */
	const loading = () =>
		el(
			"div",
			{ class: "loading" },
			el(
				"div",
				{ class: "topbar" },
				el("span", { class: "skeleton is-mark" }),
				el("span", { class: "skeleton is-name" }),
			),
			el(
				"div",
				{ class: "loading-body" },
				el("p", {}, el("span", { class: "spinner" }), "Opening…"),
				...["is-title", "", "", "is-short", "is-block"].map((cls) =>
					el("div", { class: `skeleton ${cls}` }),
				),
			),
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
		if (problem) input.setAttribute("aria-invalid", "true");
		const form = el(
			"form",
			{ class: "passphrase" },
			tile(doc, "is-accent", "lock"),
			el("h1", {}, "This note is protected"),
			el("label", { for: "passphrase" }, "Passphrase"),
			input,
			el(
				"p",
				{ class: "problem", role: "alert" },
				...(problem ? [icon(doc, "circle-alert"), problem] : []),
			),
			el("label", { class: "remember" }, remember, "Remember on this browser"),
			el("button", { type: "submit" }, "Open"),
		);
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			rememberChoice = remember.checked;
			handlers.onPassphrase(input.value, rememberChoice);
		});
		queueMicrotask(() => input.focus());
		return gate(form);
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
		markLoneImages(body);
		const headings = foldSections(body);
		const outline = createOutline(headings, signal);
		const jump = addAnchors(body, headings);
		// Jumps once laid out, and again when the address names another anchor.
		window.requestAnimationFrame(() => jump(currentAnchor()));
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
		const chips = () => factChips(doc, state, signal);
		const article = el(
			"article",
			{ class: "note" },
			title && !named ? el("h1", { class: "note-title" }, title) : "",
			body,
		);
		// A narrow screen has no room for them in the bar: they follow the name.
		const below = chips();
		if (below && named) {
			first.parentElement?.querySelector(".heading-children")?.prepend(below);
		} else if (below) {
			body.before(below);
		}
		const sidebar = createSidebar(doc, outline, state, signal);
		const reader = el("div", { class: "reader" });
		reader.append(
			createTopbar(reader, {
				title: title || "Shared note",
				menu: sidebar.menu,
				chips: chips(),
				markdown: () =>
					noteMarkdown(
						title && !named ? title : "",
						sanitizeNote(state.payload.html),
					),
			}),
			el("div", { class: "reader-body" }, sidebar.aside, article),
		);
		return reader;
	}

	function render(state: ViewState, signal: AbortSignal): HTMLElement {
		switch (state.kind) {
			case "loading":
				return loading();
			case "passphrase":
				return passphraseForm(state.problem);
			case "content":
				return content(state, signal);
			case "gone":
				return message(
					"muted",
					"hourglass",
					"This link is no longer available",
					"It has expired, reached its view limit or was removed by its owner.",
				);
			case "invalid":
				return message(
					"warning",
					"unlink",
					"This link is incomplete",
					"The address is missing its key. Ask the sender for the whole link.",
				);
			case "error":
				return message(
					"error",
					"triangle-alert",
					"This note could not be opened",
					state.message,
				);
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
