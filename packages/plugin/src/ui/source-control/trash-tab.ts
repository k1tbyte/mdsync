import { Menu, Platform, setIcon, TFile, TFolder } from "obsidian";
import type { PluginHost } from "@/plugin/host";
import { errorMessage, pluralize } from "@/shared";
import type { DeletedFilesResult } from "@/sync/history";
import {
	appendIconButton,
	attempt,
	callout,
	notifyError,
	notifyInfo,
	onLongPress,
	renderPath,
} from "@/ui/common";
import { openPromptModal } from "@/ui/modals";
import { confirmBulkRestore, confirmRestore } from "./restore-modal";
import { RowPager } from "./row-pager";
import {
	SelectionBar,
	type SelectionCommand,
	type SelectionSource,
} from "./selection-bar";
import {
	renderEmptyState,
	renderHistoryOff,
	renderLoadError,
	renderLoading,
} from "./tab-states";
import {
	buildTrashRows,
	resolveRestoreTarget,
	type TrashRow,
} from "./trash-rows";

/** Files gone from the vault but still recoverable from history. */
export class TrashTab implements SelectionSource {
	private deleted: DeletedFilesResult | null = null;
	private error: string | null = null;
	private loading = false;
	/** Invalidations race in-flight loads; only the current generation may land. */
	private generation = 0;
	/** Selected row paths; pruned to the rows the latest render produced. */
	private readonly selected = new Set<string>();
	private rows: TrashRow[] = [];
	private readonly pager = new RowPager();
	private bar: SelectionBar | null = null;
	private selectAll: HTMLInputElement | null = null;

	constructor(
		private readonly plugin: PluginHost,
		private readonly onRerender: () => void,
		private readonly openDiff: (
			path: string,
			history: { hash: string; label: string; size?: number },
		) => Promise<void>,
	) {}

	clear(): void {
		this.deleted = null;
		this.error = null;
		this.loading = false;
		this.generation++;
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
				"File version history is disabled, so deleted files are not recoverable. Enable it in settings.",
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
		this.bar?.update(false);
		const box = this.selectAll;
		if (!box) return;
		box.checked = this.selected.size === this.rows.length;
		box.indeterminate = this.selected.size > 0 && !box.checked;
	}

	private renderBody(body: HTMLElement): void {
		if (this.error) {
			renderLoadError(body, "Could not list deleted files", this.error, () => {
				this.clear();
				this.onRerender();
			});
			return;
		}
		if (this.deleted === null) {
			renderLoading(body);
			this.load();
			return;
		}
		const incomplete = this.deleted.lagging || this.deleted.truncated;
		if (this.deleted.lagging) {
			callout(
				body,
				"warning",
				"History has not caught up with the latest push yet, so recent deletions are missing. Push again to update it.",
			);
		}
		if (this.deleted.truncated) {
			callout(
				body,
				"warning",
				"History has a gap, so deletions older than it are missing unless a pinned snapshot still covers them.",
			);
		}
		const rows = buildTrashRows(this.deleted.files, {
			maxSnapshots: this.plugin.settings.fileHistoryMaxSnapshots,
			currentDevice: this.plugin.controller.currentDevice(),
			inVault: (path) =>
				this.plugin.app.vault.getAbstractFileByPath(path) instanceof TFile,
		});
		this.rows = rows;
		this.pruneSelection();
		if (rows.length === 0) {
			// The warnings above already say why the list is short; do not contradict them.
			if (!incomplete) {
				renderEmptyState(body, {
					icon: "circle-check",
					tone: "success",
					title: "Nothing to restore",
					text: `Nothing deleted in the last ${this.plugin.settings.fileHistoryMaxSnapshots} snapshots. Older deletions are dropped from history unless their snapshot is pinned.`,
				});
			}
			return;
		}
		this.renderListHead(body);
		for (const row of this.pager.slice(rows)) this.renderRow(body, row);
		this.pager.render(body, rows.length, this.onRerender);
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
			cls: "mdsync-deleted-count",
			text: `${pluralize(this.rows.length, "file")} history still holds`,
		});
	}

	/** A selection outliving its row (restored or pushed away) must not linger. */
	private pruneSelection(): void {
		const valid = new Set(this.rows.map((row) => row.path));
		for (const path of Array.from(this.selected)) {
			if (!valid.has(path)) this.selected.delete(path);
		}
	}

	/** Loads into state, never into a captured node: a re-render discards that node. */
	private load(): void {
		if (this.loading) return;
		this.loading = true;
		const generation = this.generation;
		this.plugin.controller.history
			.listDeletedFiles()
			.then((result) => {
				if (generation !== this.generation) return;
				this.deleted = result;
			})
			.catch((err: unknown) => {
				if (generation !== this.generation) return;
				this.error = errorMessage(err);
			})
			.finally(() => {
				// A newer load owns the flag now, so leave it to that one.
				if (generation !== this.generation) return;
				this.loading = false;
				this.onRerender();
			});
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
		const add = (icon: string, label: string, run: () => void): void => {
			appendIconButton(actions, icon, label, run).addClass("mdsync-row-action");
		};
		add("eye", `Preview ${row.path}`, () => this.preview(row));
		add("rotate-ccw", `Restore ${row.path}`, () => {
			void this.restore(row, row.path);
		});
		add("folder-input", `Restore ${row.path} to another path`, () => {
			void this.restoreTo(row);
		});
	}

	private showMenu(event: MouseEvent, row: TrashRow): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("Preview")
				.setIcon("eye")
				.onClick(() => this.preview(row)),
		);
		menu.addItem((item) =>
			item
				.setTitle("Restore")
				.setIcon("rotate-ccw")
				.onClick(() => void this.restore(row, row.path)),
		);
		menu.addItem((item) =>
			item
				.setTitle("Restore to…")
				.setIcon("folder-input")
				.onClick(() => void this.restoreTo(row)),
		);
		menu.showAtMouseEvent(event);
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
		const confirmed = await confirmRestore({
			plugin: this.plugin,
			path: row.path,
			target,
			version: { hash: row.hash, label: row.age, size: row.size },
		});
		if (!confirmed) return;
		try {
			await this.plugin.controller.history.restoreFileVersion(target, row.hash);
			// The row stays, marked: the remote still has the file deleted until this is pushed.
			notifyInfo(`Restored ${target}. Review and push the change when ready.`);
			this.onRerender();
		} catch (err) {
			notifyError("Restore failed", err);
		}
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
		let restored = 0;
		const failures: string[] = [];
		for (const row of rows) {
			// Same guard as a single restore, collected instead of one notice each.
			if (
				this.plugin.app.vault.getAbstractFileByPath(row.path) instanceof TFolder
			) {
				failures.push(row.path);
				continue;
			}
			try {
				await this.plugin.controller.history.restoreFileVersion(
					row.path,
					row.hash,
				);
				// Failures stay selected so the user can retry them.
				this.selected.delete(row.path);
				restored++;
			} catch {
				failures.push(row.path);
			}
		}
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
