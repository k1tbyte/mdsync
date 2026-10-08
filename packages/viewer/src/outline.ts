import { headingLevel, reveal } from "./sections";

/** Fewer headings than this need no outline. */
const MIN_HEADINGS = 3;
/** A heading above this line from the window's top is the one being read. */
const READING_LINE_PX = 96;

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
		const item = doc.createElement("button");
		item.type = "button";
		item.className = "outline-item";
		item.textContent = heading.textContent?.trim() ?? "";
		item.style.setProperty("--depth", String(headingLevel(heading) - top));
		item.addEventListener("click", () => {
			reveal(heading);
			heading.scrollIntoView({ block: "start" });
		});
		return item;
	});
	const list = doc.createElement("nav");
	list.className = "outline";
	list.setAttribute("aria-label", "Outline");
	list.append(...items);

	let frame = 0;
	const markCurrent = () => {
		frame = 0;
		let current = -1;
		headings.forEach((heading, index) => {
			// A folded heading has no box, and its zero top would count as passed.
			if (
				heading.getClientRects().length > 0 &&
				heading.getBoundingClientRect().top < READING_LINE_PX
			) {
				current = index;
			}
		});
		for (const [index, item] of items.entries()) {
			item.classList.toggle("is-active", index === current);
		}
	};
	const schedule = () => {
		if (frame === 0) frame = requestAnimationFrame(markCurrent);
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
