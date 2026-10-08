import { copyWithFeedback } from "./clipboard";
import { el } from "./dom";
import { expiryText } from "./expiry";

const COPY_LABEL = "Copy as Markdown";
/** The reader's choice of full-width text, kept for every link this relay serves. */
const WIDE_KEY = "mdsync-viewer-wide";
const EXPIRY_REFRESH_MS = 30_000;

export interface LinkFacts {
	viewsLeft: number | null;
	/** Unix seconds; null never expires. */
	expires: number | null;
}

/**
 * The column left of the note: what is left of the link, the width switch and the outline. On a narrow screen
 * it is a panel behind a menu button. Listeners end with `signal`.
 */
export function createSidebar(
	reader: HTMLElement,
	outline: HTMLElement | null,
	facts: LinkFacts,
	markdown: () => string,
	signal: AbortSignal,
): HTMLElement {
	const doc = reader.ownerDocument;
	const sidebar = el(doc, "aside", { class: "sidebar" });
	const toggle = button(doc, "sidebar-toggle", "");
	toggle.setAttribute("aria-label", "Menu");
	toggle.setAttribute("aria-expanded", "false");
	const panel = el(doc, "div", { class: "sidebar-panel" });
	panel.append(card(reader, facts, markdown, signal));
	if (outline) panel.append(outline);
	sidebar.append(toggle, panel);

	const setOpen = (open: boolean) => {
		sidebar.classList.toggle("is-open", open);
		toggle.setAttribute("aria-expanded", String(open));
	};
	toggle.addEventListener("click", () =>
		setOpen(!sidebar.classList.contains("is-open")),
	);
	panel.addEventListener("click", (event) => {
		if ((event.target as Element).closest(".outline-item")) setOpen(false);
	});
	doc.addEventListener(
		"click",
		(event) => {
			if (!sidebar.contains(event.target as Node)) setOpen(false);
		},
		{ signal },
	);
	doc.addEventListener(
		"keydown",
		(event) => {
			if (event.key === "Escape") setOpen(false);
		},
		{ signal },
	);
	return sidebar;
}

function card(
	reader: HTMLElement,
	facts: LinkFacts,
	markdown: () => string,
	signal: AbortSignal,
): HTMLElement {
	const doc = reader.ownerDocument;
	const card = el(doc, "div", { class: "link-card" });
	const fact = (cls: string, text: string) => {
		const line = el(doc, "p", { class: `link-fact ${cls}` }, text);
		card.append(line);
		return line;
	};
	if (facts.viewsLeft !== null) fact("link-views", viewsText(facts.viewsLeft));
	const { expires } = facts;
	if (expires !== null) {
		const line = fact("link-expiry", expiryText(expires, Date.now()));
		// "In 5 min" has to count down while the page stays open.
		const timer = window.setInterval(() => {
			line.textContent = expiryText(expires, Date.now());
		}, EXPIRY_REFRESH_MS);
		signal.addEventListener("abort", () => window.clearInterval(timer));
	}
	const wide = button(doc, "wide-toggle", "Wide text");
	const setWide = (on: boolean) => {
		reader.classList.toggle("is-wide", on);
		wide.setAttribute("aria-pressed", String(on));
	};
	setWide(storedWide());
	wide.addEventListener("click", () => {
		const on = !reader.classList.contains("is-wide");
		setWide(on);
		storeWide(on);
	});
	const copy = button(doc, "copy-markdown", COPY_LABEL);
	copy.addEventListener(
		"click",
		() => void copyWithFeedback(copy, COPY_LABEL, markdown),
	);
	card.append(copy, wide);
	return card;
}

function viewsText(viewsLeft: number): string {
	if (viewsLeft === 0) {
		return "This was the last view of this link. Reloading this tab keeps the note until you close it.";
	}
	return `This link can be opened ${viewsLeft} more ${viewsLeft === 1 ? "time" : "times"}.`;
}

function storedWide(): boolean {
	try {
		return window.localStorage.getItem(WIDE_KEY) === "1";
	} catch {
		return false;
	}
}

function storeWide(on: boolean): void {
	try {
		if (on) window.localStorage.setItem(WIDE_KEY, "1");
		else window.localStorage.removeItem(WIDE_KEY);
	} catch {
		// Storage blocked: the choice lasts for this page.
	}
}

function button(doc: Document, cls: string, text: string): HTMLButtonElement {
	return el(doc, "button", { type: "button", class: cls }, text);
}
