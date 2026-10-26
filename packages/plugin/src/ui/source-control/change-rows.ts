import { Platform, setIcon } from "obsidian";
import {
	appendIconButton,
	makeActivatable,
	onLongPress,
	renderPath,
} from "@/ui/common";
import { textButton } from "./action-button";
import type { SourceControlActions } from "./actions";
import type { ConflictPreviewManager } from "./conflict-preview-manager";
import { renderSize } from "./row-parts";
import { SECTION_ACTIONS } from "./section-actions";
import { ESection, type FileRow, type VisualRow } from "./types";

export type CheckState = "all" | "some" | "none";

/** What a row reads from, and reports back to, the section drawing it. */
export interface RowContext {
	section: ESection;
	layout: "tree" | "flat";
	actions: SourceControlActions;
	previews: ConflictPreviewManager;
	rerender: () => void;
	openFileDiff: (item: HTMLElement, path: string) => void;
	openMerge: (path: string) => void;
	isOpening: (path: string) => boolean;
	isActive: (path: string) => boolean;
	/** "Changed on Laptop, 5 minutes ago"; read per drawn row, never for the whole list. */
	editLabel: (path: string) => string | null;
	/** "on Laptop", "by Alex". */
	editor: (path: string) => string | null;
	/** Null where rows are not selectable. */
	selection: RowSelection | null;
	toggleFolder: (path: string) => void;
}

export interface RowSelection {
	isSelected: (path: string) => boolean;
	folderState: (folder: string) => CheckState;
	/** `range` extends from the last box toggled, as shift-click does. */
	toggleFile: (path: string, range: boolean) => void;
	toggleFolder: (folder: string) => void;
}

export function renderFolderRow(
	parent: HTMLElement,
	visual: VisualRow,
	ctx: RowContext,
): HTMLElement {
	const folderPath = visual.folderPath as string;
	const collapsed = visual.collapsed === true;
	const folder = parent.createDiv({ cls: "mdsync-tree-folder" });
	setDepth(folder, visual.depth);
	if (collapsed) folder.addClass("is-collapsed");
	const { selection } = ctx;
	if (selection) {
		folder.addClass("is-selectable");
		renderCheckbox(
			folder,
			`Select ${folderPath}`,
			selection.folderState(folderPath),
			() => selection.toggleFolder(folderPath),
		).dataset.mdsyncFolder = folderPath;
	}
	const toggle = folder.createSpan({ cls: "mdsync-tree-folder-toggle" });
	setIcon(toggle, collapsed ? "chevron-right" : "chevron-down");
	const icon = folder.createSpan({ cls: "mdsync-tree-folder-icon" });
	setIcon(icon, collapsed ? "folder" : "folder-open");
	folder.createSpan({
		cls: "mdsync-tree-folder-name",
		text: visual.name,
	});
	folder.setAttr("aria-expanded", String(!collapsed));
	onLongPress(folder, (event) =>
		ctx.actions.showFolderContextMenu(event, folderPath),
	);
	makeActivatable(folder, folderPath, () => ctx.toggleFolder(folderPath));
	folder.addEventListener("contextmenu", (event) => {
		event.preventDefault();
		ctx.actions.showFolderContextMenu(event, folderPath);
	});
	return folder;
}

/** What a tap does instead of opening the diff, and the line under the name. */
interface RowOptions {
	open?: { label: string; run: () => void };
	detail?: string;
}

export function renderFileRow(
	parent: HTMLElement,
	row: FileRow,
	depth: number,
	ctx: RowContext,
	options: RowOptions = {},
): HTMLElement {
	const item = parent.createDiv({ cls: "mdsync-file-row" });
	setDepth(item, depth);
	if (row.statusLetter === "D") item.addClass("is-deleted");
	if (ctx.isOpening(row.path)) {
		item.addClass("is-opening");
		item.setAttr("aria-busy", "true");
	}
	if (ctx.isActive(row.path)) {
		item.addClass("is-active");
		item.setAttr("aria-current", "true");
	}
	item.setAttr("data-mdsync-path", row.path);
	onLongPress(item, (event) => showFileMenu(event, row, ctx));
	const { open } = options;
	makeActivatable(item, open?.label ?? `Open diff for ${row.path}`, () =>
		open ? open.run() : ctx.openFileDiff(item, row.path),
	);
	const { selection } = ctx;
	if (selection) {
		item.addClass("is-selectable");
		renderCheckbox(
			item,
			`Select ${row.path}`,
			selection.isSelected(row.path) ? "all" : "none",
			(range) => selection.toggleFile(row.path, range),
		).dataset.mdsyncFile = row.path;
	}

	const copy = renderPath(item, row.path, ctx.layout === "flat");
	const detail =
		options.detail ??
		(row.from !== undefined
			? `from ${row.from}`
			: ctx.section === ESection.Remote
				? ctx.editLabel(row.path)
				: null);
	if (detail) copy.createSpan({ cls: "mdsync-file-parent", text: detail });

	// On a phone the size joins the line under the name; a tree row there stays one line.
	if (row.size !== undefined && !(Platform.isPhone && ctx.layout === "tree"))
		renderSize(Platform.isPhone ? copy : item, row.size, row.sizeDelta);
	renderRowActions(item, row.path, ctx);
	renderStatus(item, row);
	item.addEventListener("contextmenu", (event) => {
		event.preventDefault();
		showFileMenu(event, row, ctx);
	});
	return item;
}

/** A conflict is decided here rather than selected: its row grows the choices. Always flat, so no depth. */
export function renderConflictCard(
	parent: HTMLElement,
	row: FileRow,
	ctx: RowContext,
): HTMLElement {
	const card = parent.createDiv({ cls: "mdsync-conflict-card" });
	// A phone goes to the merge from the row; Keep local and Accept remote stay in its long-press menu.
	const compact = Platform.isPhone;
	const head = renderFileRow(
		card,
		row,
		0,
		ctx,
		compact
			? {
					open: {
						label: `Resolve ${row.path}`,
						run: () => ctx.openMerge(row.path),
					},
					detail: "tap to resolve",
				}
			: {},
	);
	head.addClass("is-conflict");
	setIcon(
		head.insertBefore(
			createSpan({ cls: "mdsync-conflict-icon" }),
			head.firstChild,
		),
		"triangle-alert",
	);
	if (compact) {
		card.addClass("is-compact");
		setIcon(
			head.createSpan({ cls: "mdsync-conflict-chevron" }),
			"chevron-right",
		);
		if (ctx.previews.isExpanded(row.path)) ctx.previews.render(card, row.path);
		return card;
	}
	appendIconButton(head, "ellipsis", "Conflict actions", (event) => {
		event.stopPropagation();
		showFileMenu(event, row, ctx);
	}).addClass("mdsync-row-action");

	const who = ctx.editor(row.path) ?? "remotely";
	card.createDiv({
		cls: "mdsync-conflict-note",
		text: `Changed here and ${who} since the last sync.`,
	});
	const choices = card.createDiv({ cls: "mdsync-conflict-choices" });
	textButton(choices, "Keep local").onClick(
		() => void ctx.actions.resolveKeepLocal(row.path),
	);
	textButton(choices, "Accept remote").onClick(
		() => void ctx.actions.resolveAcceptRemote(row.path),
	);
	textButton(choices, "Merge…").onClick(() => ctx.openMerge(row.path));
	if (ctx.previews.isExpanded(row.path)) ctx.previews.render(card, row.path);
	return card;
}

/** Ticks follow the section's selection: it redraws every box on a change, a range or a folder included. */
export function renderCheckbox(
	parent: HTMLElement,
	label: string,
	state: CheckState,
	onToggle: (range: boolean) => void,
): HTMLInputElement {
	const wrap = parent.createEl("label", { cls: "mdsync-file-selection" });
	const input = wrap.createEl("input", {
		type: "checkbox",
		cls: "mdsync-file-checkbox",
	});
	input.setAttr("aria-label", label);
	setCheck(input, state);
	wrap.addEventListener("click", (event) => {
		event.stopPropagation();
		// A click on the label arrives again as the box's own click.
		if (event.target === input) onToggle(event.shiftKey);
	});
	return input;
}

export function setCheck(input: HTMLInputElement, state: CheckState): void {
	input.checked = state === "all";
	input.indeterminate = state === "some";
}

function renderRowActions(
	item: HTMLElement,
	path: string,
	ctx: RowContext,
): void {
	const actions = SECTION_ACTIONS[ctx.section];
	if (actions.length === 0) return;
	item.addClass("has-actions");
	const bar = item.createSpan({ cls: "mdsync-row-actions" });
	for (const { icon, rowLabel, run } of actions) {
		appendIconButton(bar, icon, rowLabel, (event) => {
			event.stopPropagation();
			void run(ctx.actions, [path]);
		}).addClass("mdsync-row-action");
	}
}

function renderStatus(item: HTMLElement, row: FileRow): void {
	item.createSpan({
		cls: `mdsync-file-status ${row.statusClass}`,
		text: row.statusLetter,
	});
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
	if (depth > 0) el.style.setProperty("--mdsync-depth", String(depth));
}
