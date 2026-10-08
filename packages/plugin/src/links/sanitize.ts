export interface LocalImage {
	img: HTMLImageElement;
	link: string;
}

export interface SanitizeReport {
	/** Vault images the caller still reads and inlines; each img's src is already removed. */
	images: LocalImage[];
	/** Embeds of notes, audio, video, pdf, missing files: removed. */
	embedsDropped: number;
	/** Mermaid blocks left as their source because the vault has not allowed Mermaid. */
	mermaidAsSource: number;
}

export function sanitizeRendered(root: HTMLElement): SanitizeReport {
	const report: SanitizeReport = {
		images: [],
		embedsDropped: 0,
		mermaidAsSource: 0,
	};
	for (const frontmatter of Array.from(
		root.querySelectorAll("pre.frontmatter"),
	)) {
		frontmatter.remove();
	}
	for (const embed of Array.from(root.querySelectorAll(".internal-embed"))) {
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
	for (const wrapper of Array.from(
		root.querySelectorAll(".mermaid-wrapper.is-guarded"),
	)) {
		const pre = wrapper.querySelector(".mermaid-guard-source pre");
		if (pre) {
			wrapper.replaceWith(pre);
			report.mermaidAsSource++;
		}
	}
	for (const element of Array.from(
		root.querySelectorAll(
			"audio, video, iframe, object, embed, script, style, button",
		),
	)) {
		element.remove();
	}
	for (const anchor of Array.from(root.querySelectorAll("a"))) {
		const href = anchor.getAttribute("href") ?? "";
		if (anchor.classList.contains("tag")) {
			const tag = root.ownerDocument.createElement("span");
			tag.className = "tag";
			tag.textContent = anchor.textContent;
			anchor.replaceWith(tag);
		} else if (
			anchor.classList.contains("internal-link") ||
			!(/^(https?:|mailto:)/i.test(href) || href.startsWith("#"))
		) {
			anchor.replaceWith(
				root.ownerDocument.createTextNode(anchor.textContent ?? ""),
			);
		} else if (href.startsWith("#")) {
			anchor.removeAttribute("target");
			anchor.removeAttribute("rel");
		}
	}
	for (const img of Array.from(root.querySelectorAll("img"))) {
		const src = img.getAttribute("src");
		// Collected vault images have no src until the caller inlines them.
		if (
			src !== null &&
			!src.startsWith("https://") &&
			!src.startsWith("data:image/")
		) {
			img.remove();
		}
	}
	for (const content of Array.from(root.querySelectorAll(".callout-content"))) {
		content.removeAttribute("style");
	}
	for (const paragraph of Array.from(root.querySelectorAll("p"))) {
		if (paragraph.childElementCount === 0 && !paragraph.textContent?.trim()) {
			paragraph.remove();
		}
	}
	for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
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
	for (const checkbox of Array.from(
		root.querySelectorAll('input[type="checkbox"]'),
	)) {
		checkbox.setAttribute("disabled", "");
	}
	return report;
}

function isPathAlt(alt: string | null, link: string): boolean {
	return alt !== null && (alt === link || alt === link.split("/").pop());
}
