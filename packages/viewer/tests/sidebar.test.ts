import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSidebar } from "../src/sidebar";

let controller: AbortController;
let reader: HTMLElement;
let sidebar: HTMLElement;
let toggle: HTMLButtonElement;
const wideKey = "mdsync-viewer-wide";

beforeEach(() => {
	localStorage.clear();
	controller = new AbortController();
	reader = document.createElement("div");
	document.body.replaceChildren(reader);
});

afterEach(() => {
	controller.abort();
	localStorage.clear();
	document.body.replaceChildren();
});

const mount = (
	viewsLeft: number | null = null,
	expires: number | null = null,
	outline: HTMLElement | null = null,
	markdown: () => string = () => "# Note\n",
) => {
	sidebar = createSidebar(
		reader,
		outline,
		{ viewsLeft, expires },
		markdown,
		controller.signal,
	);
	reader.append(sidebar);
	toggle = sidebar.querySelector(".sidebar-toggle") as HTMLButtonElement;
	return sidebar;
};

const expectOpen = (open: boolean) => {
	expect(sidebar.classList.contains("is-open")).toBe(open);
	expect(toggle.getAttribute("aria-expanded")).toBe(String(open));
};

describe("sidebar", () => {
	it.each([false, true])("builds the panel with outline %s", (hasOutline) => {
		const outline = hasOutline ? document.createElement("nav") : null;
		mount(null, null, outline);
		expect(sidebar.tagName).toBe("ASIDE");
		expect(sidebar.className).toBe("sidebar");
		expect(toggle.type).toBe("button");
		expect(toggle.getAttribute("aria-label")).toBe("Menu");
		const panel = sidebar.querySelector(".sidebar-panel") as HTMLElement;
		const card = panel.querySelector(".link-card");
		expect(Array.from(sidebar.children)).toEqual([toggle, panel]);
		expect(Array.from(panel.children)).toEqual(
			outline ? [card, outline] : [card],
		);
		expect(card?.querySelector(".link-fact")).toBeNull();
		expect(card?.querySelector(".wide-toggle")?.textContent).toBe("Wide text");
	});

	it("copies the note as Markdown and says how it went", async () => {
		const writeText = vi.fn(async (_text: string) => {});
		vi.stubGlobal("navigator", { clipboard: { writeText } });
		mount();
		const copy = sidebar.querySelector(".copy-markdown") as HTMLButtonElement;
		expect(copy.textContent).toBe("Copy as Markdown");
		copy.click();
		await vi.waitFor(() => expect(copy.textContent).toBe("Copied"));
		expect(writeText).toHaveBeenCalledExactlyOnceWith("# Note\n");
		vi.unstubAllGlobals();
	});

	it("says so when the note cannot be copied", async () => {
		mount(null, null, null, () => {
			throw new Error("not convertible");
		});
		const copy = sidebar.querySelector(".copy-markdown") as HTMLButtonElement;
		copy.click();
		await vi.waitFor(() => expect(copy.textContent).toBe("Copy failed"));
	});

	it.each([
		[
			0,
			"This was the last view of this link. Reloading this tab keeps the note until you close it.",
		],
		[1, "This link can be opened 1 more time."],
		[3, "This link can be opened 3 more times."],
	] as const)("shows %i views left", (viewsLeft, text) => {
		const line = mount(viewsLeft).querySelector("p.link-fact.link-views");
		expect(line?.textContent).toBe(text);
	});

	it("toggles the menu and expanded state", () => {
		mount();
		expectOpen(false);
		toggle.click();
		expectOpen(true);
		toggle.click();
		expectOpen(false);
	});

	it("closes outside but not inside the sidebar", () => {
		mount();
		toggle.click();
		(sidebar.querySelector(".link-card") as HTMLElement).click();
		expectOpen(true);
		reader.click();
		expectOpen(false);
	});

	it("closes when an outline item is clicked", () => {
		const outline = document.createElement("nav");
		outline.innerHTML =
			'<button class="outline-item"><span>First</span></button>';
		mount(null, null, outline);
		toggle.click();
		(outline.querySelector("span") as HTMLElement).click();
		expectOpen(false);
	});

	it("closes on Escape but not other keys", () => {
		mount();
		toggle.click();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		expectOpen(true);
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		expectOpen(false);
	});

	it("stops closing outside or on Escape after abort", () => {
		mount();
		toggle.click();
		controller.abort();
		reader.click();
		expectOpen(true);
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		expectOpen(true);
	});

	it.each([false, true])(
		"starts wide from storage %s and remembers changes",
		(stored) => {
			if (stored) localStorage.setItem(wideKey, "1");
			const wide = mount().querySelector(".wide-toggle") as HTMLButtonElement;
			expect(reader.classList.contains("is-wide")).toBe(stored);
			expect(wide.getAttribute("aria-pressed")).toBe(String(stored));
			wide.click();
			expect(reader.classList.contains("is-wide")).toBe(!stored);
			expect(wide.getAttribute("aria-pressed")).toBe(String(!stored));
			expect(localStorage.getItem(wideKey)).toBe(stored ? null : "1");
			wide.click();
			expect(reader.classList.contains("is-wide")).toBe(stored);
			expect(wide.getAttribute("aria-pressed")).toBe(String(stored));
			expect(localStorage.getItem(wideKey)).toBe(stored ? "1" : null);
		},
	);
});
