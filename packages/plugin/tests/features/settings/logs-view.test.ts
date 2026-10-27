// @vitest-environment jsdom

import { installElementMethods } from "@tests/helpers/element-methods";
import { describe, expect, it, vi } from "vitest";
import { ESyncLogLevel, ESyncLogOperation } from "@/core/logs/store";
import { copyText } from "@/core/ui/controls/copyable";
import { renderLogEntry } from "@/features/settings/logs-view";

const copy = vi.hoisted(() => ({ clicks: [] as Array<() => void> }));

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<object>()),
	ExtraButtonComponent: class {
		setIcon() {
			return this;
		}
		setTooltip() {
			return this;
		}
		onClick(fn: () => void) {
			copy.clicks.push(fn);
			return this;
		}
	},
}));
vi.mock("@/core/ui/controls/copyable", () => ({
	copyText: vi.fn(() => Promise.resolve(true)),
}));

installElementMethods();

const entry = {
	id: "1",
	timestamp: 0,
	level: ESyncLogLevel.Error,
	operation: ESyncLogOperation.Push,
	message: "failed",
	details: ["one", "two"],
};

describe("renderLogEntry", () => {
	it("builds the detail list on the first open only, and keeps it", () => {
		const parent = document.createElement("div");
		renderLogEntry(parent, entry);
		const details = parent.querySelector("details") as HTMLDetailsElement;

		expect(details.querySelector("summary")?.textContent).toBe("Details (2)");
		expect(details.querySelector("ul")).toBeNull();

		details.dispatchEvent(new Event("toggle"));
		details.dispatchEvent(new Event("toggle"));

		expect(details.querySelectorAll("ul")).toHaveLength(1);
		expect(
			[...details.querySelectorAll("li")].map((li) => li.textContent),
		).toEqual(["one", "two"]);
	});

	it("copies the whole entry while the details are still closed", () => {
		copy.clicks.length = 0;
		renderLogEntry(document.createElement("div"), entry);

		copy.clicks[0]?.();

		expect(copyText).toHaveBeenCalledWith(
			"Log entry",
			expect.stringContaining("- one\n- two"),
		);
	});
});
