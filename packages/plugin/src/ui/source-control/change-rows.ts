import { setIcon } from "obsidian";
import { appendIconButton } from "@/ui/common/icon-button";
import type { SourceControlActions } from "./actions";
import type { ConflictPreviewManager } from "./conflict-preview-manager";
import { renderPath, renderSize } from "./row-parts";
import type { ESection, FileRow, VisualRow } from "./types";

/** What a row reads from, and reports back to, the section drawing it. */
export interface RowContext {
	section: ESection;
	layout: "tree" | "flat";
	actions: SourceControlActions;
	previews: ConflictPreviewManager;
	rerender: () => void;
	openFileDiff: (item: HTMLElement, path: string) => void;
	isOpening: (path: string) => boolean;
	isActive: (path: string) => boolean;
	isSelected: (path: string) => boolean;
	setSelected: (path: string, selected: boolean) => void;
	toggleFolder: (path: string) => void;
}

/** Gives a clickable non-button the semantics a keyboard user needs. */
export function makeActivatable(
	el: HTMLElement,
	label: string,
	activate: () => void,
): void {
	el.setAttr("role", "button");
	el.setAttr("tabindex", "0");
	el.setAttr("aria-label", label);
	el.addEventListener("click", () => activate());
	el.addEventListener("keydown", (event: KeyboardEvent) => {
		// A key pressed on a control inside the element belongs to that control.
		if (event.target !== el) return;
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		activate();
	});
}

export function renderFolderRow(
	parent: HTMLElement,
	visual: VisualRow,
	ctx: RowContext,
): HTMLElement {
	const folderPath = visual.folderPath as string;
	const collapsed = visual.collapsed === true;
	const folder = parent.createDiv({ cls: "obsync-tree-folder" });
	setDepth(folder, visual.depth);
	if (collapsed) folder.addClass("is-collapsed");
	const toggle = folder.createSpan({ cls: "obsync-tree-folder-toggle" });
	setIcon(toggle, collapsed ? "chevron-right" : "chevron-down");
	const icon = folder.createSpan({ cls: "obsync-tree-folder-icon" });
	setIcon(icon, collapsed ? "folder" : "folder-open");
	folder.createSpan({
		cls: "obsync-tree-folder-name",
		text: visual.name,
	});
	folder.setAttr("aria-expanded", String(!collapsed));
	makeActivatable(folder, folderPath, () => ctx.toggleFolder(folderPath));
	folder.addEventListener("contextmenu", (event) => {
		event.preventDefault();
		ctx.actions.showFolderContextMenu(event, folderPath);
	});
	return folder;
}

export function renderFileRow(
	parent: HTMLElement,
	row: FileRow,
	depth: number,
	ctx: RowContext,
): HTMLElement {
	const item = parent.createDiv({ cls: "obsync-file-row" });
	setDepth(item, depth);
	if (row.isConflict) item.addClass("is-conflict");
	if (ctx.isOpening(row.path)) {
		item.addClass("is-opening");
		item.setAttr("aria-busy", "true");
	}
	if (ctx.isActive(row.path)) {
		item.addClass("is-active");
		item.setAttr("aria-current", "true");
	}
	item.setAttr("data-obsync-path", row.path);
	makeActivatable(item, `Open diff for ${row.path}`, () =>
		ctx.openFileDiff(item, row.path),
	);

	const selection = item.createEl("label", {
		cls: "obsync-file-selection",
	});
	selection.addEventListener("click", (event) => event.stopPropagation());
	const checkbox = selection.createEl("input", {
		type: "checkbox",
		cls: "obsync-file-checkbox",
	});
	checkbox.setAttr("aria-label", `Select ${row.path}`);
	checkbox.checked = ctx.isSelected(row.path);
	checkbox.addEventListener("change", () => {
		ctx.setSelected(row.path, checkbox.checked);
	});

	renderPath(item, row.path, ctx.layout === "flat");

	if (row.isConflict) renderConflictRowControls(parent, item, row, ctx);

	if (row.size !== undefined) renderSize(item, row.size, row.sizeDelta);
	item.createSpan({
		cls: `obsync-file-status ${row.statusClass}`,
		text: row.statusLetter,
	});

	item.addEventListener("contextmenu", (event) => {
		event.preventDefault();
		showFileMenu(event, row, ctx);
	});
	return item;
}

function renderConflictRowControls(
	parent: HTMLElement,
	item: HTMLElement,
	row: FileRow,
	ctx: RowContext,
): void {
	const controls = item.createDiv({ cls: "obsync-conflict-controls" });
	const expanded = ctx.previews.isExpanded(row.path);
	const menuButton = appendIconButton(
		controls,
		"ellipsis",
		"Conflict actions",
		(event) => {
			event.stopPropagation();
			showFileMenu(event, row, ctx);
		},
	);
	menuButton.addClass("obsync-conflict-menu-button");
	menuButton.setAttr("aria-expanded", String(expanded));

	if (expanded) {
		ctx.previews.render(parent, row.path);
	}
}

function showFileMenu(event: MouseEvent, row: FileRow, ctx: RowContext): void {
	const menu = ctx.actions.createContextMenu(row.path, ctx.section);
	if (row.isConflict) {
		const expanded = ctx.previews.isExpanded(row.path);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle(expanded ? "Hide inline preview" : "Show inline preview")
				.setIcon(expanded ? "eye-off" : "eye")
				.onClick(() => {
					ctx.previews.toggle(row.path);
					ctx.rerender();
				}),
		);
	}
	menu.showAtMouseEvent(event);
}

/** Indentation the flattened tree no longer gets from nested containers. */
function setDepth(el: HTMLElement, depth: number): void {
	if (depth > 0) el.style.setProperty("--obsync-depth", String(depth));
}
