import { Menu, setIcon } from "obsidian";
import type { PluginHost } from "@/plugin/host";
import { errorMessage, pluralize } from "@/shared";
import type { FileVersion } from "@/sync/history";
import {
	appendIconButton,
	appendLabeledButton,
	attempt,
	makeActivatable,
	notifyError,
	notifyInfo,
} from "@/ui/common";
import type { HistoryDiffTarget } from "@/ui/source-control-view";

import { groupRows } from "./day-groups";
import { buildHistoryRows, type HistoryRow } from "./history-rows";
import { confirmRestore } from "./restore-modal";
import { renderSize } from "./row-parts";
import { addSnapshotPinItems } from "./snapshot-menu";
import {
	renderEmptyState,
	renderHistoryOff,
	renderLoadError,
	renderLoading,
} from "./tab-states";

export class HistoryTab {
	private explicitPath: string | null = null;
	private historyVersions: FileVersion[] | null = null;
	/** The version whose diff was opened last. */
	private selected: string | null = null;
	private error: string | null = null;
	private loadedPath: string | null = null;
	private loading = false;
	/** Invalidations race in-flight loads; only the current generation may land. */
	private generation = 0;

	constructor(
		private readonly plugin: PluginHost,
		private readonly onRerender: () => void,
		private readonly openDiff: (
			path: string,
			history?: HistoryDiffTarget,
		) => Promise<void>,
		private readonly showDeleted: () => void,
		private readonly onSnapshotsChanged: () => void,
	) {}

	get hasPath(): boolean {
		return this.resolvedPath() !== null;
	}

	setPath(path: string | null): void {
		this.explicitPath = path;
		this.clearVersions();
	}

	isFollowingCurrentFile(): boolean {
		return this.explicitPath === null;
	}

	clearVersions(): void {
		this.historyVersions = null;
		this.error = null;
		this.loadedPath = null;
		this.loading = false;
		this.generation++;
	}

	render(parent: HTMLElement, tools: HTMLElement): void {
		const pane = parent.createDiv({ cls: "mdsync-history-pane" });
		if (!this.plugin.settings.fileHistoryEnabled) {
			renderHistoryOff(
				pane,
				this.plugin.app,
				"File version history is disabled. Enable it in settings.",
			);
			return;
		}
		const path = this.resolvedPath();
		if (path === null) {
			// A deleted file has no path to open, so offer that route.
			renderEmptyState(pane, {
				icon: "file",
				tone: "muted",
				title: "No file open",
				text: "Open a file to view its history.",
				action: { text: "Browse deleted files", run: () => this.showDeleted() },
			});
			return;
		}
		appendIconButton(tools, "refresh-cw", "Refresh history", () =>
			this.reload(),
		);
		this.renderHistoryVersions(pane, path);
	}

	private reload(): void {
		this.clearVersions();
		this.onRerender();
	}

	private renderHistoryVersions(parent: HTMLElement, path: string): void {
		this.renderBackButton(parent, path);
		if (this.loadedPath !== path) {
			this.clearVersions();
			this.selected = null;
			this.loadedPath = path;
		}
		this.renderFileCard(parent, path);
		const body = parent.createDiv({ cls: "mdsync-history-list" });
		if (this.error) {
			renderLoadError(body, "Could not load history", this.error, () =>
				this.reload(),
			);
			return;
		}
		if (this.historyVersions === null) {
			renderLoading(body);
			this.load(path);
			return;
		}
		if (this.historyVersions.length === 0) {
			renderEmptyState(body, {
				icon: "history",
				title: "No versions yet",
				text: "No stored history for this file yet.",
			});
			return;
		}
		const rows = buildHistoryRows(this.historyVersions, {
			currentDevice: this.plugin.controller.currentDevice(),
		});
		for (const group of groupRows(rows)) {
			body.createDiv({ cls: "mdsync-timeline-day", text: group.label });
			const list = body.createDiv({ cls: "mdsync-history-rows" });
			for (const row of group.rows) this.renderRow(list, path, row);
		}
	}

	private renderFileCard(parent: HTMLElement, path: string): void {
		const card = parent.createDiv({ cls: "mdsync-history-file" });
		setIcon(card.createSpan({ cls: "mdsync-history-file-icon" }), "file-text");
		const copy = card.createDiv({ cls: "mdsync-history-file-copy" });
		const slash = path.lastIndexOf("/");
		copy.createDiv({
			cls: "mdsync-history-file-name",
			text: path.slice(slash + 1),
		});
		const count = this.historyVersions?.length;
		const meta = [
			slash > 0 ? path.slice(0, slash) : "",
			count ? pluralize(count, "version") : "",
		].filter(Boolean);
		if (meta.length > 0)
			copy.createDiv({
				cls: "mdsync-history-row-meta",
				text: meta.join(" · "),
			});
	}

	/** Loads into state, never into a captured node: a re-render discards that node. */
	private load(path: string): void {
		if (this.loading) return;
		this.loading = true;
		const generation = this.generation;
		this.plugin.controller.history
			.getFileHistory(path)
			.then((versions) => {
				if (generation !== this.generation) return;
				this.historyVersions = versions;
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

	/** A dot on the day's line, or a pin; the size this version weighed. */
	private renderRow(list: HTMLElement, path: string, row: HistoryRow): void {
		const item = list.createDiv({ cls: "mdsync-history-row" });
		item.toggleClass("is-latest", row.isLatest);
		item.toggleClass("is-active", this.selected === row.snapshotId);
		makeActivatable(item, `${row.title} · ${row.tooltip}`, () => {
			this.selected = row.snapshotId;
			// In place: a re-render would lose the list's scroll.
			item.parentElement?.parentElement
				?.querySelector(".mdsync-history-row.is-active")
				?.removeClass("is-active");
			item.addClass("is-active");
			attempt(
				this.openDiff(path, { ...row.version }),
				"Could not open the diff",
			);
		});
		const mark = item.createSpan({ cls: "mdsync-history-mark" });
		if (row.pinned) {
			const pin = mark.createSpan({ cls: "mdsync-history-pin" });
			setIcon(pin, "pin");
			pin.setAttr("aria-label", "Pinned snapshot");
		} else mark.createSpan({ cls: "mdsync-history-dot" });
		const copy = item.createDiv({ cls: "mdsync-timeline-copy" });
		const title = copy.createDiv({ cls: "mdsync-timeline-title" });
		title.createSpan({ cls: "mdsync-history-row-title", text: row.title });
		if (row.isLatest) title.createSpan({ cls: "mdsync-pill", text: "Latest" });
		copy.createDiv({ cls: "mdsync-history-row-meta", text: row.meta });
		renderSize(item, row.size, row.sizeDelta);
		const actions = item.createDiv({ cls: "mdsync-timeline-actions" });
		appendIconButton(actions, "ellipsis", "Version actions", (event) => {
			event.stopPropagation();
			this.showRowMenu(event, path, row);
		});
		item.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			this.showRowMenu(event, path, row);
		});
	}

	private showRowMenu(event: MouseEvent, path: string, row: HistoryRow): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("Restore this version")
				.setIcon("rotate-ccw")
				.onClick(() => void this.handleRestoreVersion(path, row)),
		);
		if (row.previous) {
			const previous = row.previous;
			menu.addItem((item) =>
				item
					.setTitle("Compare with previous")
					.setIcon("git-compare")
					.onClick(() =>
						attempt(
							this.openDiff(path, {
								...previous,
								against: { ...row.version },
							}),
							"Could not open the diff",
						),
					),
			);
		}
		menu.addSeparator();
		addSnapshotPinItems(menu, this.plugin, row, this.onSnapshotsChanged);
		menu.showAtMouseEvent(event);
	}

	private renderBackButton(parent: HTMLElement, path: string): void {
		const currentPath = this.currentFilePath();
		const canGoBack =
			this.explicitPath !== null &&
			currentPath !== null &&
			currentPath !== path;
		if (!canGoBack) return;
		appendLabeledButton(parent, "arrow-left", "Back to current file", () => {
			this.setPath(null);
			this.onRerender();
		}).addClass("mdsync-history-back");
	}

	private currentFilePath(): string | null {
		return this.plugin.app.workspace.getActiveFile()?.path ?? null;
	}

	private resolvedPath(): string | null {
		return this.explicitPath ?? this.currentFilePath();
	}

	private async handleRestoreVersion(
		path: string,
		row: HistoryRow,
	): Promise<void> {
		const confirmed = await confirmRestore({
			plugin: this.plugin,
			path,
			target: path,
			version: { ...row.version, label: row.title },
		});
		if (!confirmed) return;
		try {
			await this.plugin.controller.history.restoreFileVersion(path, row.hash);
			// The list describes the remote, which a local restore does not touch.
			notifyInfo("Restored. Review and push the change when ready.");
		} catch (err) {
			notifyError("Restore failed", err);
		}
	}
}
