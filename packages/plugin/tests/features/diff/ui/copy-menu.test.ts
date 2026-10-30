import type { Menu } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { copyText } from "@/core/ui/controls/copyable";
import { addCopyItems } from "@/features/diff/ui/copy-menu";
import type { FileDiffModel } from "@/features/sync";

vi.mock("@/core/ui/controls/copyable", () => ({
	copyText: vi.fn(async () => true),
}));

class FakeItem {
	title = "";
	click = () => {};
	setTitle(title: string) {
		this.title = title;
		return this;
	}
	setIcon() {
		return this;
	}
	onClick(click: () => void) {
		this.click = click;
		return this;
	}
}

function menuItems(model: Partial<FileDiffModel> | null) {
	const items: FakeItem[] = [];
	const menu = {
		addItem(build: (item: FakeItem) => void) {
			const item = new FakeItem();
			build(item);
			items.push(item);
			return menu;
		},
	};
	addCopyItems(menu as unknown as Menu, "a/note.md", model as FileDiffModel);
	return items;
}

const model: Partial<FileDiffModel> = {
	isBinary: false,
	leftLabel: "This device",
	leftText: "mine",
	leftPresent: true,
	rightLabel: "Incoming",
	rightText: "theirs",
	rightPresent: true,
};

describe("addCopyItems", () => {
	it("copies the path and each side's text", () => {
		const items = menuItems(model);
		expect(items.map((item) => item.title)).toEqual([
			"Copy path",
			"Copy text (This device)",
			"Copy text (Incoming)",
		]);
		items[2]?.click();
		expect(copyText).toHaveBeenLastCalledWith("Text", "theirs");
	});

	it("offers no text for an absent side, a binary file or no model", () => {
		expect(
			menuItems({ ...model, leftPresent: false }).map((item) => item.title),
		).toEqual(["Copy path", "Copy text (Incoming)"]);
		expect(menuItems({ ...model, isBinary: true })).toHaveLength(1);
		expect(menuItems(null)).toHaveLength(1);
	});
});
