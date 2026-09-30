import { FakeEl } from "@tests/helpers/fake-obsidian-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type RowContext,
	renderFileRow,
	renderFolderRow,
} from "@/ui/source-control/change-rows";
import type { FileRow } from "@/ui/source-control/types";

const row: FileRow = {
	path: "Projects/Beta/Roadmap.md",
	statusLetter: "M",
	statusClass: "obsync-status-modify",
	isConflict: false,
};

const conflictRow: FileRow = {
	path: "Inbox.md",
	statusLetter: "C",
	statusClass: "obsync-status-conflict",
	isConflict: true,
};

function context() {
	const menu = {
		addSeparator: vi.fn(),
		addItem: vi.fn(),
		showAtMouseEvent: vi.fn(),
	};
	const actions = {
		createContextMenu: vi.fn(() => menu),
		showFolderContextMenu: vi.fn(),
	};
	const ctx = {
		section: "local",
		layout: "tree",
		actions,
		previews: { isExpanded: () => false },
		openFileDiff: vi.fn(),
		isOpening: () => false,
		isActive: () => false,
		isSelected: () => false,
		setSelected: vi.fn(),
		toggleFolder: vi.fn(),
	} as unknown as RowContext;
	return { ctx, actions, menu };
}

function attached(el: HTMLElement): FakeEl {
	return Object.assign(el as unknown as FakeEl, { isConnected: true });
}

const touch = (el: FakeEl, type: string, extra: Record<string, unknown> = {}) =>
	el.fire(type, { pointerType: "touch", clientX: 0, clientY: 0, ...extra });

function hold(el: FakeEl, target?: FakeEl): void {
	touch(el, "pointerdown", target ? { target: { closest: () => target } } : {});
	vi.advanceTimersByTime(500);
}

function fileRow(fileRowData: FileRow = row) {
	const setup = context();
	const item = attached(
		renderFileRow(new FakeEl("div") as never, fileRowData, 0, setup.ctx),
	);
	return { ...setup, item };
}

const withClass = (el: FakeEl, cls: string): FakeEl =>
	el.find((child) => child.hasClass(cls))[0] as FakeEl;

describe("change rows on touch", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("window", globalThis);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("opens a file row's menu when the row is held", () => {
		const { actions, menu, item } = fileRow();
		hold(item);
		expect(actions.createContextMenu).toHaveBeenCalledWith(row.path, "local");
		expect(menu.showAtMouseEvent).toHaveBeenCalledOnce();
	});

	it("opens a folder row's menu when the row is held", () => {
		const { ctx, actions } = context();
		const folder = renderFolderRow(
			new FakeEl("div") as never,
			{ depth: 0, name: "Beta", folderPath: "Projects/Beta" },
			ctx,
		);
		hold(attached(folder));
		expect(actions.showFolderContextMenu).toHaveBeenCalledWith(
			expect.anything(),
			"Projects/Beta",
		);
	});

	it("opens the file on a tap and no menu", () => {
		const { ctx, actions, item } = fileRow();
		touch(item, "pointerdown");
		vi.advanceTimersByTime(100);
		touch(item, "pointerup");
		item.fire("click");
		expect(actions.createContextMenu).not.toHaveBeenCalled();
		expect(ctx.openFileDiff).toHaveBeenCalledWith(item, row.path);
	});

	it("does not open the file when the hold's own click arrives", () => {
		const { ctx, item } = fileRow();
		hold(item);
		touch(item, "pointerup");
		item.fire("click");
		expect(ctx.openFileDiff).not.toHaveBeenCalled();
	});

	it("opens the file on a tap that follows a hold which never got a click", () => {
		const { ctx, item } = fileRow();
		hold(item);
		touch(item, "pointercancel");
		touch(item, "pointerdown");
		touch(item, "pointerup");
		item.fire("click");
		expect(ctx.openFileDiff).toHaveBeenCalledOnce();
	});

	it("opens one menu when a touch also sends contextmenu", () => {
		const { actions, item } = fileRow();
		hold(item);
		item.fire("contextmenu", { pointerType: "touch" });
		expect(actions.createContextMenu).toHaveBeenCalledOnce();
	});

	it("opens the menu on a mouse right click", () => {
		const { actions, item } = fileRow();
		item.fire("pointerdown", { pointerType: "mouse" });
		const event = item.fire("contextmenu", { pointerType: "mouse" });
		expect(actions.createContextMenu).toHaveBeenCalledOnce();
		expect(event.defaultPrevented).toBe(true);
	});

	it("leaves the selection checkbox to its own tap", () => {
		const { actions, item } = fileRow();
		hold(item, withClass(item, "obsync-file-selection"));
		expect(actions.createContextMenu).not.toHaveBeenCalled();
	});

	it("opens the conflict menu once, from the button", () => {
		const { actions, item } = fileRow(conflictRow);
		const button = withClass(item, "obsync-conflict-menu-button");
		hold(item, button);
		expect(actions.createContextMenu).not.toHaveBeenCalled();
		touch(button, "pointerup");
		button.fire("click");
		expect(actions.createContextMenu).toHaveBeenCalledOnce();
	});
});
