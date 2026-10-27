// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { watchDiffChrome } from "@/features/diff/action-bar";

function chrome() {
	const header = document.createElement("div");
	const bar = document.createElement("div");
	const observer = watchDiffChrome(header, bar);
	return { header, bar, observer };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("diff chrome classes", () => {
	it("marks what the header and the bar hold as they change", async () => {
		const { header, bar, observer } = chrome();
		expect(bar.classList.contains("has-button")).toBe(false);

		bar.append(document.createElement("button"));
		const segments = document.createElement("div");
		segments.className = "mdsync-segments";
		header.append(segments);
		await settled();
		expect(bar.classList.contains("has-button")).toBe(true);
		expect(header.classList.contains("has-layout")).toBe(true);

		segments.hidden = true;
		bar.replaceChildren();
		await settled();
		expect(bar.classList.contains("has-button")).toBe(false);
		expect(header.classList.contains("has-layout")).toBe(false);
		observer.disconnect();
	});

	it("tells a resolution in the bar to the header, and settles after its own classes", async () => {
		const { header, bar, observer } = chrome();
		const toggle = vi.spyOn(bar.classList, "toggle");
		const resolution = document.createElement("div");
		resolution.className = "mdsync-diff-resolution";

		bar.append(resolution);
		await settled();
		const calls = toggle.mock.calls.length;
		await settled();

		expect(header.classList.contains("is-resolving")).toBe(true);
		expect(toggle.mock.calls.length).toBe(calls);
		observer.disconnect();
	});
});
