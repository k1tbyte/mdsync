// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { installElementFactories } from "@tests/helpers/obsidian-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { type SanitizeReport, sanitizeRendered } from "@/links/sanitize";

installElementFactories();

const fixture = readFileSync(
	new NodeURL("./fixtures/rendered-note.html", import.meta.url),
	"utf8",
);

function render(html: string): HTMLDivElement {
	const root = document.createElement("div");
	const parsed = new DOMParser().parseFromString(html, "text/html");
	root.append(...Array.from(parsed.body.childNodes));
	return root;
}

function emptyParagraphs(root: HTMLElement): HTMLParagraphElement[] {
	return Array.from(root.querySelectorAll("p")).filter(
		(paragraph) =>
			paragraph.childElementCount === 0 && !paragraph.textContent?.trim(),
	);
}

describe("sanitizeRendered on Obsidian output", () => {
	let root: HTMLDivElement;
	let report: SanitizeReport;

	beforeEach(() => {
		root = render(fixture);
		report = sanitizeRendered(root);
	});

	it("drops private properties and non-image embeds", () => {
		expect(root.querySelector("pre.frontmatter")).toBeNull();
		expect(root.textContent).not.toContain("hunter2");
		expect(root.textContent).not.toContain("Secret frontmatter");
		expect(root.querySelector(".internal-embed")).toBeNull();
		expect(root.textContent).not.toContain("Other note body, private.");
		expect(root.textContent).not.toContain("missing.png");
		expect(root.querySelector("audio")).toBeNull();
		expect(report.embedsDropped).toBe(3);
	});

	it("collects vault images without their private URLs", () => {
		expect(report.images.map((image) => image.link)).toEqual([
			"img.png",
			"img.png",
		]);
		for (const { img } of report.images) {
			expect(root.contains(img)).toBe(true);
			expect(img.hasAttribute("src")).toBe(false);
			expect(img.hasAttribute("alt")).toBe(false);
		}
		expect(report.images[1]?.img.getAttribute("width")).toBe("100");
		expect(
			root.querySelector('img[alt="ext image"]')?.getAttribute("src"),
		).toBe("https://example.com/pic.png");
	});

	it("unwraps vault links and turns tags into spans", () => {
		expect(root.querySelector("a.internal-link")).toBeNull();
		expect(root.querySelector("a.tag")).toBeNull();
		expect(root.querySelectorAll("span.tag")).toHaveLength(1);
		expect(root.querySelector("span.tag")?.textContent).toBe("#tag");
		const links = Array.from(root.querySelectorAll("p")).find((paragraph) =>
			paragraph.textContent?.startsWith("Links:"),
		);
		expect(links?.textContent).toContain(
			"Links: Other, an alias, Other > Section, text,",
		);
		expect(links?.querySelectorAll("a")).toHaveLength(2);
	});

	it("keeps external links and footnotes", () => {
		const external = Array.from(root.querySelectorAll("a.external-link"));
		expect(external.map((anchor) => anchor.getAttribute("href"))).toEqual([
			"https://example.com/page",
			"https://auto.example.com",
		]);
		for (const anchor of external) {
			expect(anchor.getAttribute("target")).toBe("_blank");
			expect(anchor.getAttribute("rel")).toBe("noopener nofollow");
		}
		const footnotes = root.querySelectorAll('a[href^="#fn"]');
		expect(footnotes).toHaveLength(2);
		expect(root.querySelector('a[href^="#fn-"]')).not.toBeNull();
		for (const anchor of Array.from(footnotes)) {
			expect(anchor.hasAttribute("target")).toBe(false);
			expect(anchor.hasAttribute("rel")).toBe(false);
		}
		expect(root.querySelector("section.footnotes")?.textContent).toContain(
			"The footnote text.",
		);
	});

	it("keeps callouts, math, tables, code and task lists", () => {
		const contents = root.querySelectorAll(".callout-content");
		expect(contents).toHaveLength(4);
		for (const content of Array.from(contents)) {
			expect(content.hasAttribute("style")).toBe(false);
		}
		expect(root.querySelector(".callout.is-collapsed")).not.toBeNull();
		expect(root.querySelectorAll(".callout-icon svg")).toHaveLength(4);
		expect(root.querySelectorAll("mjx-container")).toHaveLength(2);
		expect(root.querySelector("table")?.textContent).toContain("1");
		expect(root.querySelector("pre.language-ts code")?.textContent).toContain(
			"const answer",
		);
		const checkboxes = root.querySelectorAll('input[type="checkbox"]');
		expect(checkboxes).toHaveLength(2);
		for (const checkbox of Array.from(checkboxes)) {
			expect(checkbox.hasAttribute("disabled")).toBe(true);
		}
		expect(
			root.querySelectorAll('input[type="checkbox"][checked]'),
		).toHaveLength(1);
		expect(
			root.querySelector(".contains-task-list .is-checked"),
		).not.toBeNull();
	});

	it("leaves guarded Mermaid as source and removes renderer artifacts", () => {
		expect(root.querySelector(".mermaid-wrapper")).toBeNull();
		expect(root.querySelector("pre.language-mermaid")?.textContent).toContain(
			"graph",
		);
		expect(report.mermaidAsSource).toBe(1);
		expect(root.querySelector("button")).toBeNull();
		expect(emptyParagraphs(root)).toEqual([]);
		expect(root.querySelector(".node-insert-event")).toBeNull();
		expect(root.querySelector("[data-href]")).toBeNull();
	});

	it("is idempotent even before vault images are inlined", () => {
		const html = root.outerHTML;
		expect(sanitizeRendered(root)).toEqual({
			images: [],
			embedsDropped: 0,
			imagesDropped: 0,
			mermaidAsSource: 0,
		});
		expect(root.outerHTML).toBe(html);
		for (const { img } of report.images) expect(root.contains(img)).toBe(true);
	});
});

describe("sanitizeRendered edge cases", () => {
	it("removes executable elements, handlers and Obsidian attributes, including on the root", () => {
		const root =
			render(`<p class="node-insert-event" onclick="alert(1)" data-href="secret" contenteditable="true" draggable="true">safe<script>alert(1)</script></p>
			<span class="kept node-insert-event" data-heading="Title" data-custom="value" dir="rtl" onmouseover="alert(1)">text</span>
			<audio></audio><video></video><iframe></iframe><object></object><embed><style>p { color: red; }</style><button>copy</button>`);
		root.setAttribute("onclick", "alert(1)");
		root.className = "node-insert-event";
		sanitizeRendered(root);
		expect(
			root.querySelector(
				"audio, video, iframe, object, embed, script, style, button",
			),
		).toBeNull();
		expect(root.textContent).not.toContain("alert(1)");
		expect(root.hasAttribute("onclick")).toBe(false);
		expect(root.hasAttribute("class")).toBe(false);
		const paragraph = root.querySelector("p");
		expect(paragraph?.getAttributeNames()).toEqual([]);
		const span = root.querySelector("span");
		expect(span?.className).toBe("kept");
		expect(span?.getAttribute("data-heading")).toBe("Title");
		expect(span?.getAttribute("data-custom")).toBe("value");
		expect(span?.getAttribute("dir")).toBe("rtl");
		expect(span?.hasAttribute("onmouseover")).toBe(false);
	});

	it("leaves rendered Mermaid SVG untouched", () => {
		const root = render(
			'<div class="mermaid-wrapper"><svg viewBox="0 0 10 10"><path d="M0 0L10 10"></path></svg></div>',
		);
		const wrapper = root.querySelector(".mermaid-wrapper");
		const html = wrapper?.outerHTML;
		expect(sanitizeRendered(root).mermaidAsSource).toBe(0);
		expect(root.querySelector(".mermaid-wrapper")).toBe(wrapper);
		expect(wrapper?.outerHTML).toBe(html);
	});

	it("drops unsafe image sources outside embeds and keeps HTTPS and image data", () => {
		const root = render(
			'<img src="app://x/y.png"><img src="http://example.com/x.png"><img src="x.png"><img src="data:text/html,private"><img src="HTTPS://example.com/x.png"><img src="DATA:IMAGE/png;base64,aGVsbG8=">',
		);
		expect(sanitizeRendered(root)).toEqual({
			images: [],
			embedsDropped: 0,
			imagesDropped: 4,
			mermaidAsSource: 0,
		});
		expect(
			Array.from(root.querySelectorAll("img"), (img) =>
				img.getAttribute("src"),
			),
		).toEqual(["HTTPS://example.com/x.png", "DATA:IMAGE/png;base64,aGVsbG8="]);
	});

	it("unwraps non-web links without changing allowed external links", () => {
		const root = render(
			'<p><a href="javascript:alert(1)">script</a> <a href="obsidian://open">vault</a> <a href="Other.md">relative</a> <a>missing</a> <a href="https://example.com" class="internal-link">internal</a></p><a href="http://example.com" target="_blank" rel="nofollow">http</a><a href="mailto:me@example.com">mail</a><a href="#section" target="_blank" rel="nofollow">section</a>',
		);
		const external = Array.from(
			root.querySelectorAll('a[href^="http://"], a[href^="mailto:"]'),
			(anchor) => anchor.outerHTML,
		);
		sanitizeRendered(root);
		expect(root.querySelector("p")?.textContent).toBe(
			"script vault relative missing internal",
		);
		expect(root.querySelector("p a")).toBeNull();
		expect(
			Array.from(
				root.querySelectorAll('a[href^="http://"], a[href^="mailto:"]'),
				(anchor) => anchor.outerHTML,
			),
		).toEqual(external);
		expect(
			root.querySelector('a[href="#section"]')?.getAttributeNames(),
		).toEqual(["href"]);
	});

	it("keeps allowed link schemes regardless of case", () => {
		const root = render(
			'<a href="HTTPS://example.com">web</a><a href="MAILTO:me@example.com">mail</a>',
		);
		sanitizeRendered(root);
		expect(root.querySelectorAll("a")).toHaveLength(2);
	});

	it("does not collect images from dropped note transclusions", () => {
		const root = render(
			'<div class="internal-embed markdown-embed"><span class="internal-embed image-embed" src="private.png"><img src="app://private.png"></span></div><span class="internal-embed image-embed"><img alt="local"></span><span class="internal-embed image-embed">missing</span>',
		);
		const report = sanitizeRendered(root);
		expect(report.embedsDropped).toBe(2);
		expect(report.images.map((image) => image.link)).toEqual([""]);
		expect(root.querySelectorAll("img")).toHaveLength(1);
		expect(root.querySelector(".internal-embed")).toBeNull();
	});

	it("keeps an image's own description but not the vault path Obsidian puts in alt", () => {
		const root = render(
			'<span class="internal-embed image-embed" src="Private/Client/logo.png" alt="Private/Client/logo.png"><img alt="Private/Client/logo.png" src="app://x"></span><span class="internal-embed image-embed" src="Private/Client/b.png" alt="b.png"><img alt="b.png" src="app://y"></span><span class="internal-embed image-embed" src="Private/c.png" alt="Our logo"><img alt="Our logo" src="app://z"></span>',
		);
		sanitizeRendered(root);
		expect(
			Array.from(root.querySelectorAll("img"), (img) =>
				img.getAttribute("alt"),
			),
		).toEqual([null, null, "Our logo"]);
	});

	it("removes whitespace paragraphs but preserves paragraphs with elements", () => {
		const root = render("<p> \n\t</p><p><br></p><p>text</p>");
		sanitizeRendered(root);
		expect(emptyParagraphs(root)).toEqual([]);
		expect(root.querySelectorAll("p")).toHaveLength(2);
		expect(root.querySelector("p br")).not.toBeNull();
	});
});
