import { linkUrl, parseLinkLocation } from "@mdsync/protocol";

import { copyText } from "./clipboard";
import { el } from "./dom";
import { reveal } from "./sections";

/** How long an anchor button shows how the copy went. */
const RESULT_MS = 1500;

/**
 * Places in the note and the addresses to them, `#<key>/<anchor>`: an anchor is a heading's slug or an
 * element's id, as a footnote's. Each heading gets a button that copies its address. Returns the jump.
 */
export function addAnchors(
	body: HTMLElement,
	headings: HTMLHeadingElement[],
): (anchor: string | null) => void {
	const bySlug = new Map<string, HTMLHeadingElement>();
	for (const heading of headings) {
		const slug = uniqueSlug(heading.textContent ?? "", bySlug);
		bySlug.set(slug, heading);
		heading.append(anchorButton(heading, slug));
	}
	const jump = (anchor: string | null) => {
		if (anchor === null) return;
		const target = bySlug.get(anchor) ?? withId(body, anchor);
		if (!target) return;
		reveal(target);
		target.scrollIntoView({ block: "start" });
	};
	// The bare `#fn-1` would replace the key: opened in a new tab or copied, the link would be dead.
	for (const link of body.querySelectorAll('a[href^="#"]')) {
		const id = fragmentId(link.getAttribute("href") ?? "");
		// An SVG link's `href` property is read-only.
		link.setAttribute("href", addressOf(id) ?? "#");
		link.addEventListener("click", (event) => {
			event.preventDefault();
			jump(id);
		});
	}
	return jump;
}

/** The anchor the address names after the key. */
export function currentAnchor(): string | null {
	return parseLinkLocation(location.pathname, location.hash)?.anchor ?? null;
}

function addressOf(anchor: string): string | null {
	const link = parseLinkLocation(location.pathname, location.hash);
	return link ? linkUrl(location.origin, link.id, link.key, anchor) : null;
}

function anchorButton(
	heading: HTMLHeadingElement,
	anchor: string,
): HTMLButtonElement {
	const button = el(heading.ownerDocument, "button", {
		type: "button",
		class: "heading-anchor",
		"aria-label": "Copy a link to this section",
	});
	button.addEventListener(
		"click",
		() => void copyAddress(heading, button, anchor),
	);
	return button;
}

async function copyAddress(
	heading: HTMLHeadingElement,
	button: HTMLButtonElement,
	anchor: string,
): Promise<void> {
	const url = addressOf(anchor);
	if (!url) return;
	history.replaceState(null, "", url);
	heading.scrollIntoView({ block: "start", behavior: "smooth" });
	button.dataset.state = (await copyText(url)) ? "copied" : "failed";
	window.setTimeout(() => {
		delete button.dataset.state;
	}, RESULT_MS);
}

function withId(body: HTMLElement, id: string): Element | undefined {
	return Array.from(body.querySelectorAll("[id]")).find(
		(node) => node.id === id,
	);
}

/** An id with a literal `%` is not valid percent-encoding: it is then its own text. */
function fragmentId(hash: string): string {
	try {
		return decodeURIComponent(hash.slice(1));
	} catch {
		return hash.slice(1);
	}
}

function uniqueSlug(text: string, taken: Map<string, unknown>): string {
	const base =
		text
			.trim()
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, "-")
			.replace(/^-|-$/g, "") || "section";
	let slug = base;
	for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
	return slug;
}
