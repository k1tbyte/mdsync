import { copyWithFeedback } from "./clipboard";
import { el } from "./dom";
import { button, tile } from "./icons";

const COPY_LABEL = "Copy as Markdown";
/** The reader's choice of full-width text, kept for every link this relay serves. */
const WIDE_KEY = "mdsync-viewer-wide";

export interface TopbarParts {
	title: string;
	/** Opens the sidebar on a narrow screen. */
	menu: HTMLElement;
	chips: HTMLElement | null;
	markdown: () => string;
}

/** The bar over the note: its name, what is left of the link, wide text and copy. */
export function createTopbar(
	reader: HTMLElement,
	parts: TopbarParts,
): HTMLElement {
	const doc = reader.ownerDocument;
	const wide = button(doc, "wide-toggle", "move-horizontal", "Wide text");
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
	const copy = button(doc, "copy-markdown", "copy", COPY_LABEL);
	copy.addEventListener(
		"click",
		() => void copyWithFeedback(copy, COPY_LABEL, parts.markdown),
	);
	return el(
		doc,
		"header",
		{ class: "topbar" },
		parts.menu,
		tile(doc, "topbar-mark", "file-text"),
		el(doc, "span", { class: "topbar-title" }, parts.title),
		parts.chips ?? "",
		el(doc, "div", { class: "topbar-actions" }, wide, copy),
	);
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
