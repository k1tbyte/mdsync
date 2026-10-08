import { el, isElement, isHeading } from "./dom";

const FOLDED_CONTENT = ".heading-children, .callout-content";

/**
 * Nests each top-level heading with the blocks under it into a section that folds, as Obsidian's reading
 * view does: the renderer emits the blocks flat. Footnotes stay outside every section.
 */
export function foldSections(body: HTMLElement): HTMLHeadingElement[] {
	const doc = body.ownerDocument;
	const tree = el(doc, "div");
	const open: { level: number; children: HTMLElement }[] = [];
	const headings: HTMLHeadingElement[] = [];
	for (const node of Array.from(body.childNodes)) {
		if (isElement(node) && node.classList.contains("footnotes")) {
			open.length = 0;
		}
		if (!isHeading(node)) {
			(open.at(-1)?.children ?? tree).append(node);
			continue;
		}
		const level = headingLevel(node);
		while ((open.at(-1)?.level ?? 0) >= level) open.pop();
		const children = el(doc, "div", { class: "heading-children" });
		(open.at(-1)?.children ?? tree).append(section(node, children));
		open.push({ level, children });
		headings.push(node);
	}
	body.append(...tree.childNodes);
	return headings;
}

/** Unfolds every section and callout that hides the element. */
export function reveal(element: Element): void {
	let content = element.closest(FOLDED_CONTENT);
	while (content?.parentElement) {
		setFolded(content.parentElement, false);
		content = content.parentElement.closest(FOLDED_CONTENT);
	}
}

export function headingLevel(heading: HTMLHeadingElement): number {
	return Number(heading.tagName.slice(1));
}

function section(
	heading: HTMLHeadingElement,
	children: HTMLElement,
): HTMLElement {
	const doc = heading.ownerDocument;
	const section = el(doc, "section", { class: "heading-section" });
	// The fold button sits outside the heading, so it takes the heading's line height from here.
	section.style.setProperty(
		"--heading-size",
		`var(--h${headingLevel(heading)}-size)`,
	);
	const fold = el(doc, "button", {
		type: "button",
		class: "heading-fold",
		"aria-label": "Fold section",
		"aria-expanded": "true",
	});
	const toggle = () =>
		setFolded(section, !section.classList.contains("is-collapsed"));
	fold.addEventListener("click", toggle);
	heading.addEventListener("click", (event) => {
		// Selecting the heading's text, or a link or button in it, must not fold it.
		if ((event.target as Element).closest("a, button")) return;
		if (doc.getSelection()?.isCollapsed === false) return;
		toggle();
	});
	section.append(heading, fold, children);
	return section;
}

function setFolded(section: Element, folded: boolean): void {
	section.classList.toggle("is-collapsed", folded);
	section
		.querySelector(":scope > .heading-fold")
		?.setAttribute("aria-expanded", String(!folded));
}
