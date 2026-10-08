import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addAnchors, currentAnchor } from "../src/anchors";
import { foldSections } from "../src/sections";

let body: HTMLElement;
const token = "AAAAAAAAAAAAAAAAAAAAAA";
const address = `/s/${token}#${token}`;
const writeText = vi.fn<(text: string) => Promise<void>>();
const scrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
	vi.useFakeTimers();
	localStorage.clear();
	writeText.mockReset().mockResolvedValue(undefined);
	vi.stubGlobal("navigator", { clipboard: { writeText } });
	Element.prototype.scrollIntoView = vi.fn();
	history.replaceState(null, "", address);
	body = document.createElement("div");
	document.body.replaceChildren(body);
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	Element.prototype.scrollIntoView = scrollIntoView;
	history.replaceState(null, "", "/");
	localStorage.clear();
	document.body.replaceChildren();
});

describe("anchors", () => {
	it("adds an accessible button to every heading", () => {
		body.innerHTML = "<h2>First</h2><h3>Second</h3>";
		const headings = foldSections(body);
		addAnchors(body, headings);
		for (const heading of headings) {
			const button = heading.lastElementChild as HTMLButtonElement;
			expect(button.tagName).toBe("BUTTON");
			expect(button.className).toBe("heading-anchor");
			expect(button.type).toBe("button");
			expect(button.getAttribute("aria-label")).toBe(
				"Copy a link to this section",
			);
		}
	});

	it("makes unique lowercase slugs with Unicode letters", () => {
		body.innerHTML =
			"<h2> -- Hello, WORLD! 42 -- </h2><h2>Hello world 42</h2><h2>Hello world 42</h2><h2>!!!</h2><h2> </h2><h2>Été 東京</h2><h2>Section-2</h2>";
		const headings = foldSections(body);
		const jump = addAnchors(body, headings);
		for (const [index, slug] of [
			"hello-world-42",
			"hello-world-42-2",
			"hello-world-42-3",
			"section",
			"section-2",
			"été-東京",
			"section-2-2",
		].entries()) {
			jump(slug);
			expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(index + 1);
			expect(
				vi.mocked(Element.prototype.scrollIntoView).mock.contexts[index],
			).toBe(headings[index]);
			expect(Element.prototype.scrollIntoView).toHaveBeenLastCalledWith({
				block: "start",
			});
		}
	});

	it("reveals folded ancestors before jumping", () => {
		body.innerHTML = "<h1>First</h1><h2>Deep</h2><p>Body</p>";
		const headings = foldSections(body);
		const jump = addAnchors(body, headings);
		(body.querySelector(".heading-fold") as HTMLButtonElement).click();
		expect(body.querySelector(".is-collapsed")).not.toBeNull();
		Element.prototype.scrollIntoView = vi.fn(function (this: Element, options) {
			expect(body.querySelector(".is-collapsed")).toBeNull();
			expect(this).toBe(headings[1]);
			expect(options).toEqual({ block: "start" });
		});
		jump("deep");
		expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
	});

	it.each([null, "unknown"])("ignores anchor %s", (anchor) => {
		body.innerHTML = "<h2>First</h2>";
		addAnchors(body, foldSections(body))(anchor);
		expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
	});

	it.each([
		["copied", false],
		["failed", true],
	] as const)(
		"shows %s after copying a section link",
		async (state, rejects) => {
			if (rejects) writeText.mockRejectedValueOnce(new Error("Denied"));
			body.innerHTML = "<h2>Été 東京</h2>";
			addAnchors(body, foldSections(body));
			const button = body.querySelector(".heading-anchor") as HTMLButtonElement;
			const url = `${location.origin}${address}/${encodeURIComponent("été-東京")}`;
			button.click();
			await vi.advanceTimersByTimeAsync(0);
			expect(location.href).toBe(url);
			expect(writeText).toHaveBeenCalledExactlyOnceWith(url);
			expect(button.dataset.state).toBe(state);
			await vi.advanceTimersByTimeAsync(1499);
			expect(button.dataset.state).toBe(state);
			await vi.advanceTimersByTimeAsync(1);
			expect(button.hasAttribute("data-state")).toBe(false);
		},
	);

	it("shows failure when the clipboard is missing", async () => {
		vi.stubGlobal("navigator", {});
		body.innerHTML = "<h2>First</h2>";
		addAnchors(body, foldSections(body));
		const button = body.querySelector(".heading-anchor") as HTMLButtonElement;
		button.click();
		await vi.advanceTimersByTimeAsync(0);
		expect(button.dataset.state).toBe("failed");
		expect(location.hash).toBe(`#${token}/first`);
		await vi.advanceTimersByTimeAsync(1500);
		expect(button.hasAttribute("data-state")).toBe(false);
	});

	it("keeps the key in an in-note link and jumps to its target", () => {
		body.innerHTML =
			'<p><a href="#fn-1">[1]</a></p><ol><li id="fn-1">Note</li></ol>';
		addAnchors(body, []);
		const link = body.querySelector("a") as HTMLAnchorElement;
		expect(link.href).toBe(`${location.origin}${address}/fn-1`);
		link.click();
		expect(location.href).toBe(`${location.origin}${address}`);
		expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts).toEqual([
			body.querySelector("#fn-1"),
		]);
	});

	it("rewrites an SVG link too, whose href property is read-only", () => {
		body.innerHTML =
			'<svg><a href="#spot"><text>jump</text></a><circle id="spot" r="5"/></svg>';
		addAnchors(body, []);
		expect(body.querySelector("a")?.getAttribute("href")).toBe(
			`${location.origin}${address}/spot`,
		);
	});

	it("does not copy without a valid link address", async () => {
		history.replaceState(null, "", "/");
		body.innerHTML = "<h2>First</h2>";
		addAnchors(body, foldSections(body));
		const button = body.querySelector(".heading-anchor") as HTMLButtonElement;
		button.click();
		await vi.advanceTimersByTimeAsync(0);
		expect(writeText).not.toHaveBeenCalled();
		expect(location.pathname).toBe("/");
		expect(button.dataset.state).toBeUndefined();
	});
});

describe("current anchor", () => {
	it.each([
		["/", null],
		[address, null],
		[`${address}/`, null],
		[`${address}/first`, "first"],
		[`${address}/${encodeURIComponent("été-東京")}`, "été-東京"],
	] as const)("reads %s", (url, anchor) => {
		history.replaceState(null, "", url);
		expect(currentAnchor()).toBe(anchor);
	});
});
