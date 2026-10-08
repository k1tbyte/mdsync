import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { foldSections, reveal } from "../src/sections";

let body: HTMLElement;

beforeEach(() => {
	body = document.createElement("div");
	document.body.replaceChildren(body);
	document.getSelection()?.removeAllRanges();
});

afterEach(() => {
	document.getSelection()?.removeAllRanges();
	document.body.replaceChildren();
});

describe("fold sections", () => {
	it("leaves content without headings alone", () => {
		body.innerHTML = "Text<p>Intro</p>";
		const nodes = Array.from(body.childNodes);
		expect(foldSections(body)).toEqual([]);
		expect(Array.from(body.childNodes)).toEqual(nodes);
	});

	it("wraps direct headings and their following blocks", () => {
		body.innerHTML =
			"<p>Intro</p><h2>First</h2>Text<p>Body</p><div><h3>Nested</h3></div><h2>Next</h2><p>End</p>";
		const nodes = Array.from(body.childNodes);
		const headings = foldSections(body);
		const first = body.querySelector(".heading-section") as HTMLElement;
		const next = first.nextElementSibling as HTMLElement;
		const children = first.querySelector(".heading-children") as HTMLElement;
		expect(headings).toEqual([nodes[1], nodes[5]]);
		expect(Array.from(body.children)).toEqual([nodes[0], first, next]);
		expect(Array.from(first.children, (el) => el.tagName)).toEqual([
			"H2",
			"BUTTON",
			"DIV",
		]);
		expect(first.className).toBe("heading-section");
		expect(first.querySelector("button")?.className).toBe("heading-fold");
		expect(children.className).toBe("heading-children");
		expect(Array.from(children.childNodes)).toEqual(nodes.slice(2, 5));
		expect(
			Array.from(next.querySelector(".heading-children")?.childNodes ?? []),
		).toEqual([nodes[6]]);
	});

	it("nests deeper headings under the previous shallower heading", () => {
		body.innerHTML =
			"<h2>First</h2><h4>Deep</h4><h3>Middle</h3><h3>Peer</h3><h1>Last</h1>";
		const headings = Array.from(body.querySelectorAll("h1, h2, h3, h4"));
		expect(foldSections(body)).toEqual(headings);
		const sections = headings.map((heading) => heading.parentElement);
		expect(Array.from(body.children)).toEqual([sections[0], sections[4]]);
		const children = body.querySelector(".heading-children") as HTMLElement;
		expect(Array.from(children.children)).toEqual(sections.slice(1, 4));
	});

	it("keeps footnotes and following blocks outside all sections", () => {
		body.innerHTML =
			'<h1>First</h1><h2>Deep</h2><p>Body</p><div class="footnotes">Notes</div><p>After</p><h3>Last</h3>';
		const footnotes = body.querySelector(".footnotes");
		const after = body.querySelectorAll("p")[1];
		const headings = foldSections(body);
		expect(Array.from(body.children)).toEqual([
			headings[0]?.parentElement,
			footnotes,
			after,
			headings[2]?.parentElement,
		]);
	});

	it("toggles folding and the expanded state", () => {
		body.innerHTML = "<h2>First</h2><p>Body</p>";
		foldSections(body);
		const section = body.firstElementChild as HTMLElement;
		const button = section.querySelector("button") as HTMLButtonElement;
		expect(button.getAttribute("aria-expanded")).toBe("true");
		button.click();
		expect(section.classList.contains("is-collapsed")).toBe(true);
		expect(button.getAttribute("aria-expanded")).toBe("false");
		button.click();
		expect(section.classList.contains("is-collapsed")).toBe(false);
		expect(button.getAttribute("aria-expanded")).toBe("true");
	});
});

describe("heading clicks", () => {
	beforeEach(() => {
		body.innerHTML =
			'<h2><span>First</span><a href="#first"><span>Link</span></a><button><span>Copy</span></button></h2><p>Body</p>';
		foldSections(body);
	});

	it("toggles the fold from heading text", () => {
		const text = body.querySelector("h2 > span") as HTMLElement;
		const section = body.firstElementChild as HTMLElement;
		const fold = section.querySelector(".heading-fold") as HTMLButtonElement;
		text.click();
		expect(section.classList.contains("is-collapsed")).toBe(true);
		expect(fold.getAttribute("aria-expanded")).toBe("false");
		text.click();
		expect(section.classList.contains("is-collapsed")).toBe(false);
		expect(fold.getAttribute("aria-expanded")).toBe("true");
	});

	it.each(["a", "button"])("leaves a heading %s click alone", (tag) => {
		(body.querySelector(`h2 ${tag} span`) as HTMLElement).click();
		expect(body.querySelector(".is-collapsed")).toBeNull();
	});

	it("leaves selected heading text alone", () => {
		const text = body.querySelector("h2 > span") as HTMLElement;
		const range = document.createRange();
		range.selectNodeContents(text);
		const selection = document.getSelection() as Selection;
		selection.addRange(range);
		expect(selection.isCollapsed).toBe(false);
		text.click();
		expect(body.querySelector(".is-collapsed")).toBeNull();
		selection.collapseToStart();
		text.click();
		expect(body.querySelector(".is-collapsed")).not.toBeNull();
	});
});

describe("reveal", () => {
	beforeEach(() => {
		body.innerHTML =
			"<h1>First</h1><h2>Deep</h2><p><span>Target</span></p><h1>Other</h1>";
		foldSections(body);
		for (const button of body.querySelectorAll<HTMLButtonElement>("button"))
			button.click();
	});

	it("unfolds every ancestor that hides the target", () => {
		reveal(body.querySelector("span") as HTMLElement);
		const sections = body.querySelectorAll(".heading-section");
		expect(
			Array.from(sections, (el) => el.classList.contains("is-collapsed")),
		).toEqual([false, false, true]);
		expect(
			Array.from(body.querySelectorAll("button"), (el) =>
				el.getAttribute("aria-expanded"),
			),
		).toEqual(["true", "true", "false"]);
	});

	it("keeps the revealed heading's own section folded", () => {
		reveal(body.querySelector("h2") as HTMLHeadingElement);
		expect(
			Array.from(body.querySelectorAll(".heading-section"), (el) =>
				el.classList.contains("is-collapsed"),
			),
		).toEqual([false, true, true]);
	});

	it("leaves sections alone for a target outside them", () => {
		reveal(body);
		expect(body.querySelectorAll(".is-collapsed")).toHaveLength(3);
	});

	it("unfolds a callout that hides the target", () => {
		body.innerHTML =
			'<h1>A</h1><div class="callout is-collapsible is-collapsed"><div class="callout-title"></div><div class="callout-content"><p id="ref">x</p></div></div>';
		foldSections(body);
		(body.querySelector("button") as HTMLButtonElement).click();
		reveal(body.querySelector("#ref") as HTMLElement);
		expect(body.querySelectorAll(".is-collapsed")).toHaveLength(0);
	});
});
