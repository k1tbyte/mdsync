import type { Menu } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import type { SourceControlHost } from "@/features/source-control/host";
import { addSnapshotPinItems } from "@/features/source-control/timeline/snapshot-menu";

vi.mock("@/core/ui/notices", () => ({
	notifyError: vi.fn(),
	notifyInfo: vi.fn(),
}));

interface Item {
	title: string;
	click: () => unknown;
}

/** Records each item's title and click. */
function recordingMenu(): { menu: Menu; items: Item[] } {
	const items: Item[] = [];
	const menu = {
		addItem(build: (item: unknown) => void) {
			const item: Item & Record<string, unknown> = {
				title: "",
				click: () => undefined,
				setTitle(title: string) {
					item.title = title;
					return item;
				},
				setIcon: () => item,
				setDisabled: () => item,
				onClick(click: () => unknown) {
					item.click = click;
					return item;
				},
			};
			build(item);
			items.push(item);
			return menu;
		},
	};
	return { menu: menu as unknown as Menu, items };
}

describe("addSnapshotPinItems", () => {
	it("unpins in the space of the file whose History it came from", async () => {
		const setSnapshotPinned = vi.fn().mockResolvedValue(undefined);
		const plugin = {
			controller: { history: { setSnapshotPinned } },
		} as unknown as SourceControlHost;
		const { menu, items } = recordingMenu();
		const changed = vi.fn();

		addSnapshotPinItems(
			menu,
			plugin,
			{ snapshotId: "s1", pinned: true, label: "", path: "Shared/a.md" },
			changed,
		);
		await items.find(({ title }) => title === "Unpin")?.click();
		await vi.waitFor(() => expect(changed).toHaveBeenCalled());

		expect(setSnapshotPinned).toHaveBeenCalledExactlyOnceWith(
			"s1",
			false,
			undefined,
			"Shared/a.md",
		);
	});
});
