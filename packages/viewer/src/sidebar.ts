import { el } from "./dom";
import { factCard, type LinkFacts } from "./facts";
import { button, credit } from "./icons";

export interface Sidebar {
	aside: HTMLElement;
	/** Goes in the top bar; opens the sidebar on a narrow screen. */
	menu: HTMLButtonElement;
}

/**
 * The column left of the note: the outline and the credit. On a narrow screen it is a panel from the left
 * behind a menu button, with the link's facts on top. Listeners end with `signal`.
 */
export function createSidebar(
	doc: Document,
	outline: HTMLElement | null,
	facts: LinkFacts,
	signal: AbortSignal,
): Sidebar {
	const menu = button(doc, "menu-button", "menu", "Menu");
	menu.setAttribute("aria-expanded", "false");
	const close = button(doc, "menu-close", "x", "Close menu");
	const panel = el(doc, "div", { class: "sidebar-panel" }, close);
	const card = factCard(doc, facts, signal);
	if (card) panel.append(card);
	if (outline) {
		panel.append(el(doc, "p", { class: "outline-label" }, "On this page"));
		panel.append(outline);
	}
	panel.append(credit(doc));
	const aside = el(doc, "aside", { class: "sidebar" }, panel);

	const setOpen = (open: boolean) => {
		if (aside.classList.contains("is-open") === open) return;
		aside.classList.toggle("is-open", open);
		menu.setAttribute("aria-expanded", String(open));
		(open ? close : menu).focus();
	};
	menu.addEventListener("click", () => setOpen(true));
	close.addEventListener("click", () => setOpen(false));
	panel.addEventListener("click", (event) => {
		if ((event.target as Element).closest(".outline-item")) setOpen(false);
	});
	doc.addEventListener(
		"click",
		(event) => {
			const target = event.target as Node;
			// The aside itself is the dimmed backdrop around the panel.
			if (
				target === aside ||
				!(aside.contains(target) || menu.contains(target))
			)
				setOpen(false);
		},
		{ signal },
	);
	doc.addEventListener(
		"keydown",
		(event) => {
			if (event.key === "Escape") setOpen(false);
			// A wide screen shows the panel as a column, Close menu hidden: nothing covers the page.
			const drawer = getComputedStyle(close).display !== "none";
			if (event.key === "Tab" && drawer && aside.classList.contains("is-open"))
				keepTabIn(panel, event);
		},
		{ signal },
	);
	return { aside, menu };
}

/** The open panel covers the page: Tab cycles through it. */
function keepTabIn(panel: HTMLElement, event: KeyboardEvent): void {
	const items = [...panel.querySelectorAll<HTMLElement>("a[href], button")];
	const first = items[0];
	const last = items.at(-1);
	if (!first || !last) return;
	const active = panel.ownerDocument.activeElement;
	if (panel.contains(active) && active !== (event.shiftKey ? first : last))
		return;
	event.preventDefault();
	(event.shiftKey ? last : first).focus();
}
