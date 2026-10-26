import { el } from "./dom";
import { expiryLabel, expiryText } from "./expiry";
import { type IconName, icon } from "./icons";

const REFRESH_MS = 30_000;

export interface LinkFacts {
	viewsLeft: number | null;
	/** Unix seconds; null never expires. */
	expires: number | null;
}

/** What is left of the link in short: "3 more views", "Expires in 6 hours". Null for a link without limits. */
export function factChips(
	doc: Document,
	facts: LinkFacts,
	signal: AbortSignal,
): HTMLElement | null {
	const { viewsLeft, expires } = facts;
	if (viewsLeft === null && expires === null) return null;
	const chips = el(doc, "div", { class: "facts" });
	const chip = (name: IconName, text: string) => {
		const label = el(doc, "span", {}, text);
		chips.append(el(doc, "span", { class: "chip" }, icon(doc, name), label));
		return label;
	};
	if (viewsLeft !== null) chip("eye", viewsLabel(viewsLeft));
	if (expires !== null) {
		const label = chip("clock", "");
		tick(() => {
			label.textContent = expiryLabel(expires, Date.now());
		}, signal);
	}
	return chips;
}

/** The same in sentences, as a warning once the note lives only in this tab. */
export function factCard(
	doc: Document,
	facts: LinkFacts,
	signal: AbortSignal,
): HTMLElement | null {
	const { viewsLeft, expires } = facts;
	if (viewsLeft === null && expires === null) return null;
	const card = el(doc, "div", { class: "link-card" });
	const fact = (cls: string, name: IconName, text: string) => {
		const label = el(doc, "span", {}, text);
		card.append(
			el(doc, "p", { class: `link-fact ${cls}` }, icon(doc, name), label),
		);
		return label;
	};
	if (viewsLeft !== null) fact("link-views", "eye", viewsText(viewsLeft));
	if (expires === null) {
		card.classList.toggle("is-warning", viewsLeft === 0);
		return card;
	}
	const label = fact("link-expiry", "clock", "");
	tick(() => {
		label.textContent = expiryText(expires, Date.now());
		card.classList.toggle(
			"is-warning",
			viewsLeft === 0 || expires * 1000 <= Date.now(),
		);
	}, signal);
	return card;
}

function viewsLabel(viewsLeft: number): string {
	if (viewsLeft === 0) return "Last view";
	return `${viewsLeft} more ${viewsLeft === 1 ? "view" : "views"}`;
}

function viewsText(viewsLeft: number): string {
	if (viewsLeft === 0) {
		return "This was the last view of this link. Reloading this tab keeps the note until you close it.";
	}
	return `This link can be opened ${viewsLeft} more ${viewsLeft === 1 ? "time" : "times"}.`;
}

/** Runs `update` now and while the page stays open: "in 5 min" has to count down. */
function tick(update: () => void, signal: AbortSignal): void {
	update();
	const timer = window.setInterval(update, REFRESH_MS);
	signal.addEventListener("abort", () => window.clearInterval(timer));
}
