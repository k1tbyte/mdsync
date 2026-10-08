import { LINK_HREF_ALLOWED, LINK_IMAGE_SRC_ALLOWED } from "@mdsync/protocol";
import DOMPurify from "dompurify";

import { isElement, isTag } from "./dom";

const purify = DOMPurify(window);

purify.addHook("afterSanitizeAttributes", (node) => {
	if (isElement(node) && node.localName === "a") {
		for (const attribute of ["href", "xlink:href"]) {
			const href = node.getAttribute(attribute);
			if (href !== null && !LINK_HREF_ALLOWED.test(href))
				node.removeAttribute(attribute);
			if (/^https?:/i.test(href ?? "")) {
				node.setAttribute("target", "_blank");
				node.setAttribute("rel", "noopener noreferrer nofollow");
			}
		}
	}
	if (isTag(node, "img")) {
		node.removeAttribute("srcset");
		if (!LINK_IMAGE_SRC_ALLOWED.test(node.getAttribute("src") ?? ""))
			node.remove();
	}
	if (isTag(node, "input")) {
		if (node.type !== "checkbox") node.remove();
		else node.setAttribute("disabled", "");
	}
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
