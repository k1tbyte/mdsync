import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSidebar, type Sidebar } from "../src/sidebar";

let controller: AbortController;
let sidebar: Sidebar;

beforeEach(() => {
	controller = new AbortController();
});

afterEach(() => {
	controller.abort();
	document.body.replaceChildren();
});

const mount = (
	viewsLeft: number | null = null,
	expires: number | null = null,
	outline: HTMLElement | null = null,
) => {
	sidebar = createSidebar(
		document,
		outline,
		{ viewsLeft, expires },
		controller.signal,
	);
	document.body.replaceChildren(
		sidebar.menu,
		sidebar.aside,
		document.createElement("main"),
	);
	return sidebar.aside;
};

const closeButton = () =>
	sidebar.aside.querySelector(".menu-close") as HTMLButtonElement;
const card = () => sidebar.aside.querySelector(".link-card");

const expectOpen = (open: boolean) => {
	expect(sidebar.aside.classList.contains("is-open")).toBe(open);
	expect(sidebar.menu.getAttribute("aria-expanded")).toBe(String(open));
};

describe("sidebar", () => {
	it.each([false, true])("builds the panel with outline %s", (hasOutline) => {
		const outline = hasOutline ? document.createElement("nav") : null;
		const aside = mount(null, null, outline);
		expect(aside.tagName).toBe("ASIDE");
		expect(sidebar.menu.textContent).toBe("Menu");
		const panel = aside.querySelector(".sidebar-panel") as HTMLElement;
		const credit = panel.querySelector(".credit");
		expect(Array.from(panel.children)).toEqual(
			outline
				? [
						closeButton(),
						panel.querySelector(".outline-label"),
						outline,
						credit,
					]
				: [closeButton(), credit],
		);
		expect(credit?.textContent).toBe("Shared with MDSync");
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

	it("warns once the note lives only in this tab", () => {
		const past = Math.floor(Date.now() / 1000) - 60;
		mount(0);
		expect(card()?.classList.contains("is-warning")).toBe(true);
		mount(3);
		expect(card()?.classList.contains("is-warning")).toBe(false);
		mount(3, past);
		expect(card()?.classList.contains("is-warning")).toBe(true);
	});

	it("opens from the menu, closes from its own button and moves focus", () => {
		mount();
		expectOpen(false);
		sidebar.menu.click();
		expectOpen(true);
		expect(document.activeElement).toBe(closeButton());
		closeButton().click();
		expectOpen(false);
		expect(document.activeElement).toBe(sidebar.menu);
	});

	it("closes on the backdrop and outside but not inside the panel", () => {
		const aside = mount(2);
		sidebar.menu.click();
		(card() as HTMLElement).click();
		expectOpen(true);
		aside.click();
		expectOpen(false);
		sidebar.menu.click();
		(document.querySelector("main") as HTMLElement).click();
		expectOpen(false);
	});

	it("closes when an outline item is clicked", () => {
		const outline = document.createElement("nav");
		outline.innerHTML =
			'<button class="outline-item"><span>First</span></button>';
		mount(null, null, outline);
		sidebar.menu.click();
		(outline.querySelector("span") as HTMLElement).click();
		expectOpen(false);
	});

	it("closes on Escape but not other keys", () => {
		mount();
		sidebar.menu.click();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		expectOpen(true);
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		expectOpen(false);
	});

	it("keeps Tab inside the open panel", () => {
		mount();
		sidebar.menu.click();
		const link = sidebar.aside.querySelector(".credit a") as HTMLElement;
		const tab = (shiftKey: boolean) => {
			const event = new KeyboardEvent("keydown", {
				key: "Tab",
				shiftKey,
				cancelable: true,
			});
			document.dispatchEvent(event);
			return event.defaultPrevented;
		};
		expect(tab(true)).toBe(true);
		expect(document.activeElement).toBe(link);
		expect(tab(false)).toBe(true);
		expect(document.activeElement).toBe(closeButton());
		sidebar.menu.focus();
		closeButton().click();
		expect(tab(false)).toBe(false);
	});

	it("stops closing outside or on Escape after abort", () => {
		mount();
		sidebar.menu.click();
		controller.abort();
		(document.querySelector("main") as HTMLElement).click();
		expectOpen(true);
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		expectOpen(true);
	});
});
