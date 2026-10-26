import { el } from "./dom";
import { headingLevel, reveal } from "./sections";

/** Fewer headings than this need no outline. */
const MIN_HEADINGS = 3;
/** A heading this far below where a jump leaves it still counts as the one being read. */
const READING_SLACK_PX = 16;

/** The note's headings as a list that jumps to them and marks the one being read. Listeners end with `signal`. */
export function createOutline(
	headings: HTMLHeadingElement[],
	signal: AbortSignal,
): HTMLElement | null {
	const first = headings[0];
	if (!first || headings.length < MIN_HEADINGS) return null;
	const doc = first.ownerDocument;
	const top = Math.min(...headings.map(headingLevel));
	const items = headings.map((heading) => {
		const item = el(
			doc,
			"button",
			{ type: "button", class: "outline-item" },
			heading.textContent?.trim() ?? "",
		);
		item.style.setProperty("--depth", String(headingLevel(heading) - top));
		item.addEventListener("click", () => {
			reveal(heading);
			heading.scrollIntoView({ block: "start" });
		});
		return item;
	});
	const list = el(
		doc,
		"nav",
		{ class: "outline", "aria-label": "Outline" },
		...items,
	);

	let frame = 0;
	const markCurrent = () => {
		frame = 0;
		// A jump leaves a heading its scroll margin from the top, below the sticky bar.
		const line =
			Number.parseFloat(window.getComputedStyle(first).scrollMarginTop) +
			READING_SLACK_PX;
		let current = -1;
		headings.forEach((heading, index) => {
			// A folded heading has no box, and its zero top would count as passed.
			if (
				heading.getClientRects().length > 0 &&
				heading.getBoundingClientRect().top < line
			) {
				current = index;
			}
		});
		for (const [index, item] of items.entries()) {
			item.classList.toggle("is-active", index === current);
		}
	};
	const schedule = () => {
		if (frame === 0) frame = window.requestAnimationFrame(markCurrent);
	};
	doc.defaultView?.addEventListener("scroll", schedule, {
		passive: true,
		signal,
	});
	// A fold moves the headings without a scroll.
	doc.addEventListener("click", schedule, { signal });
	schedule();
	return list;
}
