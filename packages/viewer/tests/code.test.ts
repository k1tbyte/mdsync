import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addCopyButtons } from "../src/code";

let body: HTMLElement;
const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
	vi.useFakeTimers();
	writeText.mockReset().mockResolvedValue(undefined);
	vi.stubGlobal("navigator", { clipboard: { writeText } });
	body = document.createElement("div");
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("copy buttons", () => {
	it("adds a copy button after each code block", () => {
		body.innerHTML =
			"<pre><code>first</code></pre><pre><code>second</code></pre><p><code>inline</code></p><pre>plain</pre>";
		addCopyButtons(body);
		const buttons = body.querySelectorAll<HTMLButtonElement>("button");
		expect(buttons).toHaveLength(2);
		for (const [index, code] of body.querySelectorAll("pre > code").entries()) {
			expect(code.nextElementSibling).toBe(buttons[index]);
		}
		for (const button of buttons) {
			expect(button.className).toBe("copy-code-button");
			expect(button.type).toBe("button");
			expect(button.textContent).toBe("Copy");
		}
	});

	it("leaves content without code blocks alone", () => {
		body.innerHTML = "<p>Text</p>";
		addCopyButtons(body);
		expect(body.innerHTML).toBe("<p>Text</p>");
	});

	it.each([
		["Copied", false],
		["Copy failed", true],
	] as const)("shows %s after copying", async (label, rejects) => {
		if (rejects) writeText.mockRejectedValueOnce(new Error("Denied"));
		body.innerHTML = "<pre><code>  first\nsecond &lt;third&gt;\n</code></pre>";
		addCopyButtons(body);
		const button = body.querySelector("button") as HTMLButtonElement;
		button.click();
		await vi.advanceTimersByTimeAsync(0);
		expect(writeText).toHaveBeenCalledExactlyOnceWith(
			"  first\nsecond <third>\n",
		);
		expect(button.textContent).toBe(label);
		await vi.advanceTimersByTimeAsync(1499);
		expect(button.textContent).toBe(label);
		await vi.advanceTimersByTimeAsync(1);
		expect(button.textContent).toBe("Copy");
	});
});
