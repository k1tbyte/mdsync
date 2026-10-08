import DOMPurify from "dompurify";

/** Anything else is a path into the owner's vault or the relay, and leads nowhere here. */
const KEPT_LINK = /^(https?:|mailto:|#)/i;
const KEPT_IMAGE = /^(data:image\/|https:\/\/)/i;

const purify = DOMPurify(window);

purify.addHook("afterSanitizeAttributes", (node) => {
	if (node instanceof HTMLAnchorElement) {
		const href = node.getAttribute("href");
		if (href !== null && !KEPT_LINK.test(href)) node.removeAttribute("href");
		if (/^https?:/i.test(href ?? "")) {
			node.setAttribute("target", "_blank");
			node.setAttribute("rel", "noopener noreferrer nofollow");
		}
	}
	if (node instanceof HTMLImageElement) {
		node.removeAttribute("srcset");
		if (!KEPT_IMAGE.test(node.getAttribute("src") ?? "")) node.remove();
	}
	if (node instanceof HTMLInputElement) node.setAttribute("disabled", "");
});

/** The note's HTML as a fragment safe to attach: no script, no handlers, no way out of the page. */
export function sanitizeNote(html: string): DocumentFragment {
	// Unsupported, DOMPurify hands the markup back untouched.
	if (!purify.isSupported) {
		throw new Error("This browser cannot show a shared note safely.");
	}
	return purify.sanitize(html, {
		USE_PROFILES: { html: true, svg: true, mathMl: true },
		FORBID_TAGS: [
			"form",
			"button",
			"textarea",
			"select",
			"style",
			"link",
			"meta",
			"base",
		],
		FORBID_ATTR: ["formaction", "srcset"],
		RETURN_DOM_FRAGMENT: true,
	});
}
