import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTopbar } from "../src/topbar";

let reader: HTMLElement;
const wideKey = "mdsync-viewer-wide";

beforeEach(() => {
	localStorage.clear();
	reader = document.createElement("div");
	document.body.replaceChildren(reader);
});

afterEach(() => {
	localStorage.clear();
	document.body.replaceChildren();
	vi.unstubAllGlobals();
});

const mount = (markdown: () => string = () => "# Note\n") => {
	const bar = createTopbar(reader, {
		title: "Note",
		menu: document.createElement("button"),
		chips: null,
		markdown,
	});
	reader.append(bar);
	return bar;
};

describe("topbar", () => {
	it("copies the note as Markdown and says how it went", async () => {
		const writeText = vi.fn(async (_text: string) => {});
		vi.stubGlobal("navigator", { clipboard: { writeText } });
		const copy = mount().querySelector(".copy-markdown") as HTMLButtonElement;
		expect(copy.textContent).toBe("Copy as Markdown");
		copy.click();
		await vi.waitFor(() => expect(copy.textContent).toBe("Copied"));
		// A phone shows the label only while it reports.
		expect(copy.dataset.state).toBe("copied");
		expect(copy.querySelector("svg")).not.toBeNull();
		expect(writeText).toHaveBeenCalledExactlyOnceWith("# Note\n");
	});

	it("keeps a second copy's result its full time", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("navigator", { clipboard: { writeText: async () => {} } });
		const copy = mount().querySelector(".copy-markdown") as HTMLButtonElement;
		copy.click();
		await vi.advanceTimersByTimeAsync(1000);
		copy.click();
		await vi.advanceTimersByTimeAsync(1000);
		expect(copy.dataset.state).toBe("copied");
		await vi.advanceTimersByTimeAsync(600);
		expect(copy.textContent).toBe("Copy as Markdown");
		vi.useRealTimers();
	});

	it("says so when the note cannot be copied", async () => {
		const copy = mount(() => {
			throw new Error("not convertible");
		}).querySelector(".copy-markdown") as HTMLButtonElement;
		copy.click();
		await vi.waitFor(() => expect(copy.textContent).toBe("Copy failed"));
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
			expect(localStorage.getItem(wideKey)).toBe(stored ? "1" : null);
		},
	);
});
