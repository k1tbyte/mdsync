import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOutline } from "../src/outline";
import { foldSections } from "../src/sections";

let controller: AbortController;
let body: HTMLElement;
let headings: HTMLHeadingElement[];
let outline: HTMLElement;
const scrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
	vi.useFakeTimers();
	controller = new AbortController();
	body = document.createElement("div");
	body.innerHTML = "<h3>First</h3><h5>Deep</h5><h2>Last</h2>";
	headings = foldSections(body);
	outline = createOutline(headings, controller.signal) as HTMLElement;
	document.body.replaceChildren(body, outline);
});

afterEach(() => {
	controller.abort();
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
	Element.prototype.scrollIntoView = scrollIntoView;
	document.body.replaceChildren();
});

describe("outline", () => {
	it.each([0, 1, 2])("skips an outline for %i headings", (count) => {
		expect(
			createOutline(headings.slice(0, count), controller.signal),
		).toBeNull();
	});

	it("lists headings with depths relative to the smallest level", () => {
		expect(outline.tagName).toBe("NAV");
		expect(outline.className).toBe("outline");
		expect(outline.getAttribute("aria-label")).toBe("Outline");
		const items = outline.querySelectorAll<HTMLButtonElement>(".outline-item");
		expect(Array.from(outline.children)).toEqual(Array.from(items));
		expect(items).toHaveLength(3);
		expect(Array.from(items, (item) => item.tagName)).toEqual([
			"BUTTON",
			"BUTTON",
			"BUTTON",
		]);
		expect(Array.from(items, (item) => item.textContent)).toEqual([
			"First",
			"Deep",
			"Last",
		]);
		expect(
			Array.from(items, (item) => item.style.getPropertyValue("--depth")),
		).toEqual(["1", "3", "0"]);
	});

	it("reveals a heading before scrolling", () => {
		const section = body.querySelector(".heading-section") as HTMLElement;
		(section.querySelector(".heading-fold") as HTMLButtonElement).click();
		expect(section.classList.contains("is-collapsed")).toBe(true);
		const scrolled: Element[] = [];
		Element.prototype.scrollIntoView = function (this: Element, options) {
			expect(section.classList.contains("is-collapsed")).toBe(false);
			expect(options).toEqual({ block: "start" });
			scrolled.push(this);
		};
		const item = outline.querySelector(
			".outline-item:nth-child(2)",
		) as HTMLButtonElement;
		item.click();
		expect(scrolled).toEqual([headings[1]]);
	});

	it("handles scroll frames without layout boxes", async () => {
		await vi.advanceTimersByTimeAsync(16);
		window.dispatchEvent(new Event("scroll"));
		window.dispatchEvent(new Event("scroll"));
		await vi.advanceTimersByTimeAsync(16);
		expect(outline.querySelector(".is-active")).toBeNull();
	});

	it.each(["scroll", "click"])("tracks headings after a %s", async (event) => {
		let tops = [40, 120, 200];
		for (const [index, heading] of headings.entries()) {
			vi.spyOn(heading, "getClientRects").mockReturnValue({
				length: index === 2 ? 0 : 1,
			} as DOMRectList);
			vi.spyOn(heading, "getBoundingClientRect").mockImplementation(
				() => ({ top: tops[index] }) as DOMRect,
			);
		}
		await vi.advanceTimersByTimeAsync(16);
		expect(outline.querySelector(".is-active")).toBe(outline.children[0]);
		tops = [0, 40, 0];
		const frame = vi.spyOn(window, "requestAnimationFrame");
		const target = event === "scroll" ? window : document;
		target.dispatchEvent(new Event(event));
		target.dispatchEvent(new Event(event));
		expect(frame).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(16);
		expect(outline.querySelector(".is-active")).toBe(outline.children[1]);
	});

	it("stops scheduling frames after abort", async () => {
		await vi.advanceTimersByTimeAsync(16);
		const frame = vi.spyOn(window, "requestAnimationFrame");
		controller.abort();
		window.dispatchEvent(new Event("scroll"));
		body.click();
		expect(frame).not.toHaveBeenCalled();
	});
});
