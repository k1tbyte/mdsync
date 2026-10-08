import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createView } from "../src/view";

let root: HTMLElement;
const submitted: [string, boolean][] = [];
const views: ReturnType<typeof createView>[] = [];
const scrollIntoView = Element.prototype.scrollIntoView;
const scrolled: Element[] = [];

beforeEach(() => {
	vi.useFakeTimers();
	localStorage.clear();
	history.replaceState(null, "", "/");
	document.body.innerHTML = '<main id="app"></main>';
	root = document.getElementById("app") as HTMLElement;
	submitted.length = 0;
	scrolled.length = 0;
	Element.prototype.scrollIntoView = function (this: Element, options) {
		expect(options).toEqual({ block: "start" });
		scrolled.push(this);
	};
});

afterEach(() => {
	for (const v of views) v.show({ kind: "loading" });
	views.length = 0;
	vi.clearAllTimers();
	vi.useRealTimers();
	Element.prototype.scrollIntoView = scrollIntoView;
	history.replaceState(null, "", "/");
	localStorage.clear();
});

const view = () => {
	const v = createView(root, {
		onPassphrase: (value, remember) => submitted.push([value, remember]),
	});
	views.push(v);
	return v;
};
const showContent = (
	html: string,
	viewsLeft: number | null = null,
	title = "Trip",
) => {
	const v = view();
	v.show({
		kind: "content",
		payload: { title, html, createdAt: 1 },
		viewsLeft,
		expires: null,
	});
	return v;
};

describe("states", () => {
	it.each([
		["gone", "This link is no longer available"],
		["invalid", "This link is incomplete"],
	] as const)("shows %s", (kind, heading) => {
		view().show({ kind });
		expect(root.querySelector("h1")?.textContent).toBe(heading);
	});

	it("shows an error with its reason", () => {
		view().show({ kind: "error", message: "The relay answered 502." });
		expect(root.textContent).toContain("The relay answered 502.");
	});

	it("replaces the previous state", () => {
		const v = view();
		v.show({ kind: "loading" });
		v.show({ kind: "gone" });
		expect(root.querySelector(".loading")).toBeNull();
		expect(root.children).toHaveLength(1);
	});

	it("submits the passphrase and shows the problem", () => {
		const v = view();
		v.show({ kind: "passphrase", problem: "Wrong passphrase." });
		expect(root.querySelector(".problem")?.textContent).toBe(
			"Wrong passphrase.",
		);
		const input = root.querySelector("input") as HTMLInputElement;
		input.value = "correct horse";
		const form = root.querySelector("form");
		form?.dispatchEvent(new Event("submit", { cancelable: true }));
		const remember = root.querySelector(".remember input") as HTMLInputElement;
		remember.checked = false;
		form?.dispatchEvent(new Event("submit", { cancelable: true }));
		v.show({ kind: "passphrase", problem: "Wrong passphrase." });
		expect(
			(root.querySelector(".remember input") as HTMLInputElement).checked,
		).toBe(false);
		expect(submitted).toEqual([
			["correct horse", true],
			["correct horse", false],
		]);
		expect(input.type).toBe("password");
	});
});
describe("content", () => {
	it.each(["Trip", "Other"])("avoids repeating the title %s", (title) => {
		showContent("<h1>Trip</h1>", null, title);
		expect(root.querySelector(".note-title")?.textContent ?? null).toBe(
			title === "Trip" ? null : "Other",
		);
	});

	it.each([2, 3, 4])("uses an outline for %i headings when needed", (count) => {
		showContent("<h2>Stop</h2>".repeat(count));
		const reader = root.querySelector(".reader") as HTMLElement;
		expect(reader.className).toBe("reader");
		expect(Array.from(reader.children, (el) => el.tagName)).toEqual([
			"ASIDE",
			"ARTICLE",
		]);
		expect(reader.firstElementChild?.className).toBe("sidebar");
		expect(
			reader.querySelectorAll(".sidebar-panel > nav.outline"),
		).toHaveLength(count >= 3 ? 1 : 0);
	});

	it("unfolds a footnote before scrolling to it", () => {
		showContent(
			'<a href="#fn-1">[1]</a><h2>Notes</h2><ol><li id="fn-1">Note</li></ol>',
		);
		const section = root.querySelector(".heading-section") as HTMLElement;
		(section.querySelector(".heading-fold") as HTMLButtonElement).click();
		expect(section.classList.contains("is-collapsed")).toBe(true);
		(root.querySelector(".markdown-rendered a") as HTMLAnchorElement).click();
		expect(section.classList.contains("is-collapsed")).toBe(false);
		expect(scrolled).toEqual([root.querySelector("#fn-1")]);
	});

	it("shows the sanitized note under its title and sets the tab title", () => {
		showContent("<p>Hello <b>world</b></p><script>alert(1)</script>");
		expect(root.querySelector(".note-title")?.textContent).toBe("Trip");
		expect(root.querySelector(".markdown-rendered p")?.textContent).toBe(
			"Hello world",
		);
		expect(root.querySelector("script")).toBeNull();
		expect(document.title).toBe("Trip");
		expect(root.querySelector(".link-views")).toBeNull();
	});

	it("tells how many views are left", () => {
		const show = (viewsLeft: number) => {
			showContent("<p>x</p>", viewsLeft);
			return root.querySelector(".link-views")?.textContent;
		};
		expect(show(1)).toBe("This link can be opened 1 more time.");
		expect(show(3)).toBe("This link can be opened 3 more times.");
		expect(show(0)).toContain("last view");
	});

	it.each([false, true])("toggles only collapsible callouts: %s", (folds) => {
		const classes = folds ? "callout is-collapsible is-collapsed" : "callout";
		showContent(
			`<div class="${classes}" data-callout="note"><div class="callout-title"><span>Note</span></div><div class="callout-content">x</div></div>`,
		);
		const callout = root.querySelector(".callout") as HTMLElement;
		const title = callout.querySelector("span") as HTMLElement;
		title.click();
		expect(callout.classList.contains("is-collapsed")).toBe(false);
		title.click();
		expect(callout.classList.contains("is-collapsed")).toBe(folds);
	});

	it("jumps within the note without replacing the key", () => {
		history.replaceState(null, "", "/s/abc#key");
		showContent(
			'<p>Text<sup><a href="#fn-1">[1]</a></sup></p><ol><li id="fn-1">Note</li></ol>',
		);
		const anchor = root.querySelector("a") as HTMLAnchorElement;
		const click = new MouseEvent("click", { bubbles: true, cancelable: true });
		anchor.dispatchEvent(click);
		expect(click.defaultPrevented).toBe(true);
		expect(scrolled).toEqual([root.querySelector("#fn-1")]);
		expect(location.hash).toBe("#key");
	});

	it("jumps to an id with a literal percent sign", () => {
		showContent('<a href="#100%">top</a><h2 id="100%">100%</h2>');
		(root.querySelector("a") as HTMLAnchorElement).dispatchEvent(
			new MouseEvent("click", { bubbles: true, cancelable: true }),
		);
		expect(scrolled).toEqual([root.querySelector('h2[id="100%"]')]);
	});

	it("jumps after render and on hash changes until the next show", async () => {
		const token = "AAAAAAAAAAAAAAAAAAAAAA";
		const address = `/s/${token}#${token}`;
		history.replaceState(null, "", `${address}/first`);
		const v = showContent("<h2>First</h2><h2>Second</h2>");
		const headings = root.querySelectorAll("h2");
		expect(scrolled).toEqual([]);
		await vi.advanceTimersByTimeAsync(16);
		expect(scrolled).toEqual([headings[0]]);
		history.replaceState(null, "", `${address}/second`);
		window.dispatchEvent(new HashChangeEvent("hashchange"));
		expect(scrolled).toEqual([headings[0], headings[1]]);
		v.show({ kind: "gone" });
		history.replaceState(null, "", `${address}/first`);
		window.dispatchEvent(new HashChangeEvent("hashchange"));
		expect(scrolled).toHaveLength(2);
	});
});
