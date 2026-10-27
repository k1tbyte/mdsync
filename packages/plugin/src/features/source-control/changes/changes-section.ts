import { Menu, setIcon } from "obsidian";
import { appendIconButton, makeActivatable } from "@/core/ui";
import { EConflictStrategy } from "@/features/sync/controller";
import { SECTION_ACTIONS } from "../actions/section-actions";
import type {
	SelectionCommand,
	SelectionSource,
} from "../actions/selection-bar";
import { RowPager } from "../history/row-pager";
import { ESection, type FileRow, type VisualRow } from "../types";
import { mountVirtualList, type VirtualListHandle } from "../virtual-list";
import {
	type CheckState,
	type RowContext,
	type RowSelection,
	renderCheckbox,
	renderConflictCard,
	renderFileRow,
	renderFolderRow,
	setCheck,
} from "./change-rows";
import { buildTree, flattenRows, flattenTree } from "./tree-builder";

export interface ChangesSectionDeps
	extends Pick<
		RowContext,
		| "actions"
		| "previews"
		| "rerender"
		| "openFileDiff"
		| "openMerge"
		| "isOpening"
		| "isActive"
		| "editLabel"
		| "editor"
	> {
	scroller: () => HTMLElement | null;
	layout: () => "tree" | "flat";
	isBusy: () => boolean;
	refreshLists: () => void;
	/** The selection bar under the lists recounts. */
	selectionChanged: () => void;
}

/** Below this a list is built whole, so a row height change (an expanded conflict preview) needs no measuring. */
const VIRTUAL_MIN_ROWS = 100;

/** One section of the Changes pane: its header, selection, folders and list. */
export class ChangesSection implements SelectionSource {
	private collapsed = false;
	private readonly selected = new Set<string>();
	private readonly expandedFolders = new Set<string>();
	/** Rows as filtered: what a header or folder box selects. */
	private rows: ReadonlyArray<FileRow> = [];
	/** Files under each folder, "" for the section; counted once per render. */
	private folderTotals = new Map<string, number>();
	/** Selected files under each folder; dropped on every change, recounted when a box asks. */
	private folderChosen: Map<string, number> | null = null;
	/** Files in display order, for shift-click ranges. */
	private visibleFiles: string[] = [];
	private anchor: string | null = null;
	private listEl: HTMLElement | null = null;
	private countEl: HTMLElement | null = null;
	private headerCheck: HTMLInputElement | null = null;
	private headerButtons: HTMLButtonElement[] = [];
	private list: VirtualListHandle | null = null;
	/** Conflict rows grow inline previews, so they page instead of windowing. */
	private readonly pager = new RowPager();

	constructor(
		readonly id: ESection,
		private readonly title: string,
		private readonly deps: ChangesSectionDeps,
	) {}

	private get selectable(): boolean {
		return SECTION_ACTIONS[this.id].length > 0;
	}

	get selectedCount(): number {
		return this.selected.size;
	}

	pruneSelection(rows: ReadonlyArray<FileRow>): void {
		if (this.selected.size === 0) return;
		const present = new Set(rows.map((row) => row.path));
		for (const path of this.selected) {
			if (!present.has(path)) this.selected.delete(path);
		}
	}

	/** What the selection bar offers for this section; unticks what it sent only on success, so a failure leaves it to retry. */
	selectionCommands(): SelectionCommand[] {
		const paths = [...this.selected];
		if (paths.length === 0) return [];
		return SECTION_ACTIONS[this.id].map(({ text, cta, run }) => ({
			text: text(paths.length),
			cta,
			run: async () => {
				if (await run(this.deps.actions, paths)) this.setMany(paths, false);
			},
		}));
	}

	clearSelection(): void {
		this.setMany(this.selected, false);
	}

	destroyList(): void {
		this.list?.destroy();
		this.list = null;
	}

	refreshList(): void {
		this.list?.refresh();
	}

	updateUi(busy: boolean): void {
		this.countEl?.setText(this.rows.length.toLocaleString());
		for (const button of this.headerButtons) button.disabled = busy;
	}

	render(
		parent: HTMLElement,
		rows: ReadonlyArray<FileRow>,
		busy: boolean,
	): void {
		this.rows = rows;
		this.listEl = null;
		this.countEl = null;
		this.headerCheck = null;
		this.headerButtons = [];
		if (rows.length === 0) return;
		this.folderTotals = countByFolder(rows);
		this.folderChosen = null;

		const sectionEl = parent.createDiv({ cls: `mdsync-section is-${this.id}` });
		const header = sectionEl.createDiv({ cls: "mdsync-section-header" });
		const disclosure = header.createSpan({ cls: "mdsync-section-disclosure" });
		if (this.selectable) {
			this.headerCheck = renderCheckbox(
				header,
				`Select all ${this.title.toLowerCase()}`,
				this.folderState(""),
				() => this.toggleFolder(""),
			);
		}
		header.createSpan({ cls: "mdsync-section-title", text: this.title });
		this.renderHeaderActions(header);
		this.countEl = header.createSpan({ cls: "mdsync-section-count" });
		const showCollapsed = (): void => {
			sectionEl.toggleClass("is-collapsed", this.collapsed);
			header.setAttr("aria-expanded", String(!this.collapsed));
			setIcon(disclosure, this.collapsed ? "chevron-right" : "chevron-down");
		};
		showCollapsed();
		const body = sectionEl.createDiv({ cls: "mdsync-section-body" });
		let built = false;
		// A collapsed section builds nothing until it is first opened, by then maybe no longer busy.
		const buildBody = (now: boolean): void => {
			if (built) return;
			built = true;
			this.listEl = body.createDiv({ cls: "mdsync-file-list" });
			this.layoutList(this.listEl, rows);
			this.updateUi(now);
		};
		makeActivatable(header, `${this.title} section`, () => {
			this.collapsed = !this.collapsed;
			showCollapsed();
			if (!this.collapsed) buildBody(this.deps.isBusy());
			// Hiding a body moves every section under it, and a windowed list
			// reads its own position to decide which rows to hold.
			this.deps.refreshLists();
		});
		if (!this.collapsed) buildBody(busy);
		this.updateUi(busy);
	}

	/** Whole-section actions; Push and Pull of everything live in the summary above. */
	private renderHeaderActions(header: HTMLElement): void {
		const bar = header.createSpan({ cls: "mdsync-section-actions" });
		const { actions } = this.deps;
		const add = (
			icon: string,
			label: string,
			run: (event: MouseEvent) => void,
		): void => {
			const button = appendIconButton(bar, icon, label, (event) => {
				event.stopPropagation();
				run(event);
			});
			button.addClass("mdsync-row-action");
			this.headerButtons.push(button);
		};
		if (this.id === ESection.Local) {
			add(
				"rotate-ccw",
				"Revert all local changes",
				() => void actions.revertAll(),
			);
		} else if (this.id === ESection.Conflicts) {
			add("ellipsis", "Resolve all conflicts", (event) => {
				const menu = new Menu();
				menu.addItem((item) =>
					item
						.setTitle("Keep all local")
						.setIcon("check")
						.onClick(
							() => void actions.batchResolve(EConflictStrategy.KeepLocal),
						),
				);
				menu.addItem((item) =>
					item
						.setTitle("Accept all remote")
						.setIcon("download")
						.onClick(
							() => void actions.batchResolve(EConflictStrategy.AcceptRemote),
						),
				);
				menu.showAtMouseEvent(event);
			});
		}
	}

	private folderState(folder: string): CheckState {
		const total = this.folderTotals.get(folder) ?? 0;
		this.folderChosen ??= countByFolder(
			this.rows.filter(({ path }) => this.selected.has(path)),
		);
		const chosen = this.folderChosen.get(folder) ?? 0;
		if (chosen === 0) return "none";
		return chosen < total ? "some" : "all";
	}

	/** A folder ticks everything under it, collapsed subfolders included; "" is the section. */
	private toggleFolder(folder: string): void {
		const on = this.folderState(folder) !== "all";
		const prefix = `${folder}/`;
		const under = this.rows
			.map(({ path }) => path)
			.filter((path) => folder === "" || path.startsWith(prefix));
		this.setMany(under, on);
	}

	private toggleFile(path: string, range: boolean): void {
		const on = !this.selected.has(path);
		const from =
			range && this.anchor !== null
				? this.visibleFiles.indexOf(this.anchor)
				: -1;
		const to = this.visibleFiles.indexOf(path);
		this.anchor = path;
		if (from < 0 || to < 0) {
			this.setMany([path], on);
			return;
		}
		this.setMany(
			this.visibleFiles.slice(Math.min(from, to), Math.max(from, to) + 1),
			on,
		);
	}

	private setMany(paths: Iterable<string>, on: boolean): void {
		for (const path of [...paths]) {
			if (on) this.selected.add(path);
			else this.selected.delete(path);
		}
		this.folderChosen = null;
		this.syncChecks();
		this.deps.selectionChanged();
	}

	/** Rows drawn later read the selection themselves; these are the ones on screen now. */
	private syncChecks(): void {
		if (this.headerCheck) setCheck(this.headerCheck, this.folderState(""));
		const boxes =
			this.listEl?.querySelectorAll<HTMLInputElement>(
				".mdsync-file-checkbox",
			) ?? [];
		for (const box of boxes) {
			const { mdsyncFile, mdsyncFolder } = box.dataset;
			if (mdsyncFolder !== undefined) {
				setCheck(box, this.folderState(mdsyncFolder));
			} else if (mdsyncFile !== undefined) {
				setCheck(box, this.selected.has(mdsyncFile) ? "all" : "none");
			}
		}
	}

	/** Refills in place: expanding a folder changes which rows exist without touching the rest of the pane. */
	private layoutList(list: HTMLElement, rows: ReadonlyArray<FileRow>): void {
		const scroller = this.deps.scroller();
		// Dropping the list drops its height, and the browser clamps the pane's
		// scroll position to what is left before the new list restores it.
		const scrollTop = scroller?.scrollTop ?? 0;
		this.destroyList();
		list.empty();

		// A conflict waits on a choice, so none hides in a collapsed folder.
		const layout = this.id === ESection.Conflicts ? "flat" : this.deps.layout();
		const visual =
			layout === "flat"
				? flattenRows(rows)
				: flattenTree(buildTree(rows), (path) =>
						this.expandedFolders.has(path),
					);
		this.visibleFiles = visual.flatMap((row) =>
			row.row ? [row.row.path] : [],
		);
		const selection: RowSelection | null = this.selectable
			? {
					isSelected: (path) => this.selected.has(path),
					folderState: (folder) => this.folderState(folder),
					toggleFile: (path, range) => this.toggleFile(path, range),
					toggleFolder: (folder) => this.toggleFolder(folder),
				}
			: null;
		const ctx: RowContext = {
			...this.deps,
			section: this.id,
			layout,
			selection,
			toggleFolder: (path) => {
				if (this.expandedFolders.has(path)) this.expandedFolders.delete(path);
				else this.expandedFolders.add(path);
				this.layoutList(list, rows);
			},
		};
		const buildRow = (visualRow: VisualRow): HTMLElement => {
			const { row } = visualRow;
			if (!row) return renderFolderRow(list, visualRow, ctx);
			return this.id === ESection.Conflicts
				? renderConflictCard(list, row, ctx)
				: renderFileRow(list, row, visualRow.depth, ctx);
		};
		const build = (index: number): HTMLElement =>
			buildRow(visual[index] as VisualRow);

		// Conflict cards are taller than the pitch a windowed list places rows on.
		if (this.id === ESection.Conflicts) {
			for (const visualRow of this.pager.slice(visual)) buildRow(visualRow);
			this.pager.render(list, visual.length, () => this.layoutList(list, rows));
		} else if (!scroller || visual.length < VIRTUAL_MIN_ROWS) {
			for (let index = 0; index < visual.length; index++) build(index);
		} else {
			this.list = mountVirtualList({
				scroller,
				container: list,
				count: visual.length,
				renderRow: build,
			});
		}
		if (scroller) scroller.scrollTop = scrollTop;
		// This section just changed height, which moves every section under it.
		this.deps.refreshLists();
	}
}

/** Rows under each folder of their paths, "" counting them all. */
function countByFolder(rows: ReadonlyArray<FileRow>): Map<string, number> {
	const counts = new Map<string, number>([["", rows.length]]);
	for (const { path } of rows) {
		for (let at = path.indexOf("/"); at > 0; at = path.indexOf("/", at + 1)) {
			const folder = path.slice(0, at);
			counts.set(folder, (counts.get(folder) ?? 0) + 1);
		}
	}
	return counts;
}
