import { LINK_HREF_ALLOWED, LINK_IMAGE_SRC_ALLOWED } from "@mdsync/protocol";

export interface LocalImage {
	img: HTMLImageElement;
	link: string;
}

export interface SanitizeReport {
	/** Vault images the caller still reads and inlines; each img's src is already removed. */
	images: LocalImage[];
	/** Embeds of notes, audio, video, pdf, missing files: removed. */
	embedsDropped: number;
	imagesDropped: number;
	/** Mermaid blocks left as their source because the vault has not allowed Mermaid. */
	mermaidAsSource: number;
}

export function sanitizeRendered(root: HTMLElement): SanitizeReport {
	const report: SanitizeReport = {
		images: [],
		embedsDropped: 0,
		imagesDropped: 0,
		mermaidAsSource: 0,
	};
	removeFrontmatter(root);
	collectEmbeds(root, report);
	unguardMermaid(root, report);
	removeUnsafeElements(root);
	sanitizeAnchors(root);
	sanitizeImages(root, report);
	unfoldCallouts(root);
	removeEmptyParagraphs(root);
	sanitizeAttributes(root);
	disableCheckboxes(root);
	return report;
}

function removeFrontmatter(root: HTMLElement): void {
	for (const frontmatter of root.querySelectorAll("pre.frontmatter")) {
		frontmatter.remove();
	}
}

function collectEmbeds(root: HTMLElement, report: SanitizeReport): void {
	for (const embed of root.querySelectorAll(".internal-embed")) {
		if (!root.contains(embed)) continue;
		const img = embed.querySelector("img");
		if (embed.classList.contains("image-embed") && img) {
			const link = embed.getAttribute("src") ?? "";
			report.images.push({ img, link });
			img.removeAttribute("src");
			// Obsidian's default alt is the link as typed, folders of the vault included.
			if (isPathAlt(img.getAttribute("alt"), link)) img.removeAttribute("alt");
			embed.replaceWith(img);
		} else {
			embed.remove();
			report.embedsDropped++;
		}
	}
}

function unguardMermaid(root: HTMLElement, report: SanitizeReport): void {
	for (const wrapper of root.querySelectorAll(".mermaid-wrapper.is-guarded")) {
		const pre = wrapper.querySelector(".mermaid-guard-source pre");
		if (pre) {
			wrapper.replaceWith(pre);
			report.mermaidAsSource++;
		}
	}
}

function removeUnsafeElements(root: HTMLElement): void {
	for (const element of root.querySelectorAll(
		"audio, video, iframe, object, embed, script, style, button",
	)) {
		element.remove();
	}
}

function sanitizeAnchors(root: HTMLElement): void {
	for (const anchor of root.querySelectorAll("a")) {
		const href = anchor.getAttribute("href") ?? "";
		if (anchor.classList.contains("tag")) {
			const tag = root.ownerDocument.createElement("span");
			tag.className = "tag";
			tag.textContent = anchor.textContent;
			anchor.replaceWith(tag);
		} else if (
			anchor.classList.contains("internal-link") ||
			!LINK_HREF_ALLOWED.test(href)
		) {
			anchor.replaceWith(
				root.ownerDocument.createTextNode(anchor.textContent ?? ""),
			);
		} else if (href.startsWith("#")) {
			anchor.removeAttribute("target");
			anchor.removeAttribute("rel");
		}
	}
}

function sanitizeImages(root: HTMLElement, report: SanitizeReport): void {
	for (const img of root.querySelectorAll("img")) {
		const src = img.getAttribute("src");
		// Collected vault images have no src until the caller inlines them.
		if (src !== null && !LINK_IMAGE_SRC_ALLOWED.test(src)) {
			img.remove();
			report.imagesDropped++;
		}
	}
}

function unfoldCallouts(root: HTMLElement): void {
	for (const content of root.querySelectorAll(".callout-content")) {
		content.removeAttribute("style");
	}
}

function removeEmptyParagraphs(root: HTMLElement): void {
	for (const paragraph of root.querySelectorAll("p")) {
		if (paragraph.childElementCount === 0 && !paragraph.textContent?.trim()) {
			paragraph.remove();
		}
	}
}

function sanitizeAttributes(root: HTMLElement): void {
	stripAttributes(root);
	for (const element of root.querySelectorAll("*")) stripAttributes(element);
}

function stripAttributes(element: Element): void {
	for (const attribute of Array.from(element.attributes)) {
		if (
			attribute.name === "data-href" ||
			attribute.name === "contenteditable" ||
			attribute.name === "draggable" ||
			attribute.name.toLowerCase().startsWith("on")
		) {
			element.removeAttribute(attribute.name);
		}
	}
	element.classList.remove("node-insert-event");
	if (element.getAttribute("class") === "") element.removeAttribute("class");
}

function disableCheckboxes(root: HTMLElement): void {
	for (const checkbox of root.querySelectorAll('input[type="checkbox"]')) {
		checkbox.setAttribute("disabled", "");
	}
}

function isPathAlt(alt: string | null, link: string): boolean {
	return alt !== null && (alt === link || alt === link.split("/").pop());
}
