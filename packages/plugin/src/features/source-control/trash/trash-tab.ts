import {
	Menu,
	Platform,
	SearchComponent,
	setIcon,
	TFile,
	TFolder,
} from "obsidian";
import { HISTORY_KEEP_TEXT } from "@/core/constants";
import {
	appendIconButton,
	attempt,
	callout,
	notifyError,
	notifyInfo,
	onLongPress,
	openPromptModal,
	renderPath,
} from "@/core/ui";
import { confirmBulkRestore } from "@/features/diff";
import type { DeletedFilesResult } from "@/features/sync";
import {
	SelectionBar,
	type SelectionCommand,
	type SelectionSource,
} from "../actions/selection-bar";
import { HistoryList } from "../history/history-list";
import { RowPager } from "../history/row-pager";
import type { SourceControlHost } from "../host";
import { confirmAndRestoreFile } from "../restore-file";
import {
	renderEmptyState,
	renderHistoryOff,
	renderLoadError,
	renderLoading,
} from "../tab-states";
import {
	buildTrashRows,
	resolveRestoreTarget,
	type TrashRow,
} from "./trash-rows";

/** Files gone from the vault but still recoverable from history. */
export class TrashTab implements SelectionSource {
	private readonly list = new HistoryList<DeletedFilesResult>(() =>
		this.onRerender(),
	);
	/** Selected row paths; pruned to the rows the latest render produced. */
	private readonly selected = new Set<string>();
	/** The rows the filter shows: Select all and restore act on these alone. */
	private rows: TrashRow[] = [];
	private query = "";
	private readonly pager = new RowPager();
	private bar: SelectionBar | null = null;
	private selectAll: HTMLInputElement | null = null;

	constructor(
		private readonly plugin: SourceControlHost,
		private readonly onRerender: () => void,
		private readonly openDiff: (
			path: string,
			history: { hash: string; label: string; size?: number },
		) => Promise<void>,
	) {}

	clear(): void {
		this.list.clear();
	}

	clearOffline(): boolean {
		if (!this.list.offline) return false;
		this.clear();
		return true;
	}

	/** `overlay` holds the selection bar over the pane, outside its scroll. */
	render(parent: HTMLElement, tools: HTMLElement, overlay: HTMLElement): void {
		this.bar = null;
		this.selectAll = null;
		const pane = parent.createDiv({ cls: "mdsync-history-pane" });
		if (!this.plugin.settings.fileHistoryEnabled) {
			renderHistoryOff(
				pane,
				this.plugin.app,
				"History is off, so deleted files cannot be recovered. Turn on History in MDSync settings.",
			);
			return;
		}
		parent.addClass("mdsync-deleted-panel");
		appendIconButton(tools, "refresh-cw", "Refresh deleted", () => {
			this.clear();
			this.onRerender();
		});
		this.renderBody(pane.createDiv({ cls: "mdsync-history-list" }));
		this.bar = new SelectionBar(overlay, [this]);
		this.selectionChanged();
	}

	get selectedCount(): number {
		return this.selected.size;
	}

	selectionCommands(): SelectionCommand[] {
		return [
			{
				text: `Restore ${this.selected.size}`,
				cta: true,
				run: () => this.restoreSelected(),
			},
		];
	}

	clearSelection(): void {
		this.selected.clear();
		this.onRerender();
	}

	private selectionChanged(): void {
		// Until a list is in, the ticked rows are the last one's and may be back.
		this.bar?.update(this.list.value === null || this.list.error !== null);
		const box = this.selectAll;
		if (!box) return;
		box.checked = this.selected.size === this.rows.length;
		box.indeterminate = this.selected.size > 0 && !box.checked;
	}

	private renderBody(body: HTMLElement): void {
		const { value: deleted, error } = this.list;
		if (error) {
			renderLoadError(body, "Could not list deleted files", error, () => {
				this.clear();
				this.onRerender();
			});
			return;
		}
		if (deleted === null) {
			renderLoading(body);
			this.list.load(() => this.plugin.controller.history.listDeletedFiles());
			return;
		}
		const incomplete = deleted.lagging || deleted.truncated;
		if (deleted.lagging) {
			callout(
				body,
				"warning",
				"History has not caught up with the latest push yet, so recent deletions are missing. Push again to update it.",
			);
		}
		if (deleted.truncated) {
			callout(
				body,
				"warning",
				"History has a gap, so deletions older than it are missing unless a pinned snapshot still covers them.",
			);
		}
		const rows = buildTrashRows(deleted.files, {
			currentDevice: this.plugin.controller.currentDevice(),
			inVault: (path) =>
				this.plugin.app.vault.getAbstractFileByPath(path) instanceof TFile,
		});
		if (rows.length === 0) {
			this.rows = rows;
			this.pruneSelection();
			// The warnings above already say why the list is short; do not contradict them.
			if (!incomplete) {
				renderEmptyState(body, {
					icon: "circle-check",
					tone: "success",
					title: "Nothing to restore",
					text: this.isKeptForGood()
						? "Nothing deleted in the kept history."
						: `Nothing deleted in the last ${this.keepText()}. Older deletions drop out unless a pinned snapshot holds them.`,
				});
			}
			return;
		}
		const bar = body.createDiv({ cls: "mdsync-timeline-filter" });
		const list = body.createDiv({ cls: "mdsync-deleted-list" });
		// Typing redraws the list alone, so the field keeps its focus.
		const redraw = (): void => {
			list.empty();
			this.renderRows(list, rows, incomplete);
		};
		new SearchComponent(bar)
			.setPlaceholder("Filter by path or folder")
			.setValue(this.query)
			.onChange((value) => {
				this.query = value;
				redraw();
			})
			.inputEl.setAttr("aria-label", "Filter deleted files by path");
		redraw();
	}

	/** A filter drops the rows it hides from the selection. */
	private renderRows(
		list: HTMLElement,
		rows: readonly TrashRow[],
		incomplete: boolean,
	): void {
		const query = this.query.trim().toLowerCase();
		this.rows = rows.filter((row) => row.path.toLowerCase().includes(query));
		this.pruneSelection();
		this.selectAll = null;
		if (this.rows.length === 0) {
			renderEmptyState(list, {
				icon: "search-x",
				tone: "muted",
				title: `No deleted files match ${this.query.trim()}`,
				text: incomplete
					? "Nothing under this path was deleted in the history that can be read."
					: "Nothing under this path was deleted in the kept history.",
				action: {
					text: "Clear filter",
					run: () => {
						this.query = "";
						this.onRerender();
					},
				},
			});
		} else {
			this.renderListHead(list);
			for (const row of this.pager.slice(this.rows)) this.renderRow(list, row);
			this.pager.render(list, this.rows.length, this.onRerender);
		}
		this.selectionChanged();
	}

	private isKeptForGood(): boolean {
		return this.plugin.settings.fileHistoryKeep === "forever";
	}

	private keepText(): string {
		return HISTORY_KEEP_TEXT[this.plugin.settings.fileHistoryKeep];
	}

	private renderListHead(body: HTMLElement): void {
		const head = body.createDiv({ cls: "mdsync-deleted-head" });
		const label = head.createEl("label", { cls: "mdsync-deleted-all" });
		const box = label.createEl("input", {
			type: "checkbox",
			cls: "mdsync-file-checkbox",
		});
		label.appendText("Select all");
		box.addEventListener("change", () => {
			if (this.selected.size === this.rows.length) this.selected.clear();
			else for (const row of this.rows) this.selected.add(row.path);
			this.onRerender();
		});
		this.selectAll = box;
		head.createSpan({
			cls: "mdsync-deleted-kept",
			text: this.isKeptForGood()
				? "Kept for good"
				: `Kept ${this.keepText()} after deletion`,
		});
	}

	/** A selection outliving its row (restored or pushed away) must not linger. */
	private pruneSelection(): void {
		const valid = new Set(this.rows.map((row) => row.path));
		for (const path of Array.from(this.selected)) {
			if (!valid.has(path)) this.selected.delete(path);
		}
	}

	private renderRow(body: HTMLElement, row: TrashRow): void {
		const item = body.createDiv({ cls: "mdsync-deleted-row" });
		item.toggleClass("is-selected", this.selected.has(row.path));
		const selection = item.createEl("label", {
			cls: "mdsync-file-selection",
		});
		const checkbox = selection.createEl("input", {
			type: "checkbox",
			cls: "mdsync-file-checkbox",
		});
		checkbox.checked = this.selected.has(row.path);
		checkbox.setAttr("aria-label", `Select ${row.path}`);
		checkbox.addEventListener("change", () => {
			if (checkbox.checked) this.selected.add(row.path);
			else this.selected.delete(row.path);
			item.toggleClass("is-selected", checkbox.checked);
			this.selectionChanged();
		});
		const copy = item.createDiv({ cls: "mdsync-deleted-copy" });
		renderPath(copy, row.path);
		copy.createDiv({ cls: "mdsync-history-row-meta", text: row.meta });
		if (row.note) {
			const note = copy.createDiv({
				cls: `mdsync-deleted-note is-${row.note.tone}`,
			});
			setIcon(
				note.createSpan({ cls: "mdsync-deleted-note-icon" }),
				row.note.icon,
			);
			note.createSpan({ text: row.note.text });
		}
		// A phone has no hover, so its actions wait behind the menu.
		if (Platform.isPhone) {
			const actions = item.createDiv({ cls: "mdsync-timeline-actions" });
			appendIconButton(
				actions,
				"ellipsis",
				`Actions for ${row.path}`,
				(event) => this.showMenu(event, row),
			);
			onLongPress(item, (event) => this.showMenu(event, row));
		} else this.renderActions(item, row);
		item.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			this.showMenu(event, row);
		});
	}

	/** Shown on hover over the row's spare column, so revealing them moves nothing. */
	private renderActions(parent: HTMLElement, row: TrashRow): void {
		const actions = parent.createDiv({ cls: "mdsync-row-actions" });
		for (const { icon, label, run } of this.actionsOf(row)) {
			appendIconButton(actions, icon, label, run).addClass("mdsync-row-action");
		}
	}

	private showMenu(event: MouseEvent, row: TrashRow): void {
		const menu = new Menu();
		for (const { icon, title, run } of this.actionsOf(row)) {
			menu.addItem((item) => item.setTitle(title).setIcon(icon).onClick(run));
		}
		menu.showAtMouseEvent(event);
	}

	private actionsOf(row: TrashRow) {
		return [
			{
				icon: "eye",
				title: "Preview",
				label: `Preview ${row.path}`,
				run: () => this.preview(row),
			},
			{
				icon: "rotate-ccw",
				title: "Restore",
				label: `Restore ${row.path}`,
				run: () => void this.restore(row, row.path),
			},
			{
				icon: "folder-input",
				title: "Restore to…",
				label: `Restore ${row.path} to another path`,
				run: () => void this.restoreTo(row),
			},
		];
	}

	private preview(row: TrashRow): void {
		attempt(
			this.openDiff(row.path, {
				hash: row.hash,
				label: row.label,
				size: row.size,
			}),
			"Could not open the diff",
		);
	}

	private async restoreTo(row: TrashRow): Promise<void> {
		const target = await openPromptModal({
			app: this.plugin.app,
			title: "Restore to a different path",
			icon: "folder-input",
			description: `Where should "${row.path}" be written?`,
			label: "Vault-relative path",
			initialValue: row.path,
			confirmLabel: "Restore",
		});
		if (target === null) return;
		const resolved = resolveRestoreTarget(target);
		if (!resolved) {
			notifyError(
				"Restore failed",
				new Error(`"${target}" is not a path inside this vault.`),
			);
			return;
		}
		await this.restore(row, resolved);
	}

	private async restore(row: TrashRow, target: string): Promise<void> {
		if (!this.targetIsWritable(target)) return;
		// The diff modal is the confirmation: it names the target and shows the change.
		await confirmAndRestoreFile(
			this.plugin,
			{
				path: row.path,
				target,
				version: { hash: row.hash, label: row.age, size: row.size },
			},
			`Restored ${target}. Review and push the change when ready.`,
			// The row stays, marked: the remote still has the file deleted until this is pushed.
			this.onRerender,
		);
	}

	/** A folder at the target cannot take file bytes, so stop before the preview. */
	private targetIsWritable(target: string): boolean {
		const existing = this.plugin.app.vault.getAbstractFileByPath(target);
		if (existing instanceof TFolder) {
			notifyError(
				"Restore failed",
				new Error(
					`"${target}" is a folder, so a file cannot be written there.`,
				),
			);
			return false;
		}
		return true;
	}

	private async restoreSelected(): Promise<void> {
		const rows = this.rows.filter((row) => this.selected.has(row.path));
		if (rows.length === 0) return;
		const confirmed = await confirmBulkRestore(
			this.plugin,
			rows.map((row) => ({
				path: row.path,
				label: row.label,
				size: row.size,
			})),
		);
		if (!confirmed) return;
		// Same guard as a single restore, collected instead of one notice each.
		const folders = new Set(
			rows
				.filter(
					(row) =>
						this.plugin.app.vault.getAbstractFileByPath(row.path) instanceof
						TFolder,
				)
				.map((row) => row.path),
		);
		const items = rows
			.filter((row) => !folders.has(row.path))
			.map(({ path, hash }) => ({ path, hash }));
		// A rejection is the closing refresh and loses which paths failed, so all stay selected, as a refresh per file did.
		const failed = new Set([
			...folders,
			...(await this.plugin.controller.history
				.restoreFileVersions(items)
				.catch(() => items.map((item) => item.path))),
		]);
		let restored = 0;
		for (const { path } of items) {
			if (failed.has(path)) continue;
			// Failures stay selected so the user can retry them.
			this.selected.delete(path);
			restored++;
		}
		const failures = rows.map((row) => row.path).filter((p) => failed.has(p));
		if (restored > 0) {
			notifyInfo(`Restored ${restored} file(s). Review and push when ready.`);
		}
		if (failures.length > 0) {
			notifyError(
				"Could not restore some files",
				new Error(failures.join(", ")),
			);
		}
		this.onRerender();
	}
}
