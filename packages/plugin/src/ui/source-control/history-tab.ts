import { Menu, setIcon } from "obsidian";
import type { PluginHost } from "@/plugin/host";
import { errorMessage } from "@/shared";
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

export class HistoryTab {
	private explicitPath: string | null = null;
	private historyVersions: FileVersion[] | null = null;
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

	render(parent: HTMLElement): void {
		const pane = parent.createDiv({ cls: "obsync-history-pane" });
		if (!this.plugin.settings.fileHistoryEnabled) {
			pane.createDiv({
				cls: "obsync-status-line",
				text: "File version history is disabled. Enable it in settings.",
			});
			return;
		}
		const path = this.resolvedPath();
		if (path === null) {
			this.renderNoFile(pane);
			return;
		}
		this.renderHistoryVersions(pane, path);
	}

	/** History needs a file, but a deleted one has no path to open - offer that route. */
	private renderNoFile(pane: HTMLElement): void {
		pane.createDiv({
			cls: "obsync-status-line is-empty",
			text: "Open a file to view its history.",
		});
		const link = pane.createEl("button", { text: "Browse deleted files" });
		link.addEventListener("click", () => this.showDeleted());
	}

	private renderHistoryVersions(parent: HTMLElement, path: string): void {
		const header = parent.createDiv({ cls: "obsync-history-versions-head" });
		const bar = header.createDiv({ cls: "obsync-history-head-actions" });
		this.renderBackButton(bar, path);
		appendLabeledButton(bar, "refresh-cw", "Refresh history", () => {
			this.clearVersions();
			this.onRerender();
		});

		const body = parent.createDiv({
			cls: "obsync-history-list obsync-timeline-list",
		});
		if (this.loadedPath !== path) {
			this.clearVersions();
			this.loadedPath = path;
		}
		if (this.error) {
			body.createDiv({
				cls: "obsync-history-error",
				text: `Could not load history: ${this.error}`,
			});
			return;
		}
		if (this.historyVersions === null) {
			body.createDiv({ cls: "obsync-status-line", text: "Loading…" });
			this.load(path);
			return;
		}
		if (this.historyVersions.length === 0) {
			body.createDiv({
				cls: "obsync-status-line is-empty",
				text: "No stored history for this file yet.",
			});
			return;
		}
		const rows = buildHistoryRows(this.historyVersions, {
			currentDevice: this.plugin.controller.currentDevice(),
		});
		for (const group of groupRows(rows)) {
			body.createDiv({ cls: "obsync-timeline-day", text: group.label });
			for (const row of group.rows) this.renderRow(body, path, row);
		}
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

	/** Same card as the timeline, plus the size this version weighed. */
	private renderRow(body: HTMLElement, path: string, row: HistoryRow): void {
		const card = body.createDiv({ cls: "obsync-timeline-card" });
		const head = card.createDiv({ cls: "obsync-timeline-head" });
		makeActivatable(head, `${row.title} · ${row.tooltip}`, () =>
			attempt(
				this.openDiff(path, { ...row.version }),
				"Could not open the diff",
			),
		);
		const copy = head.createDiv({ cls: "obsync-timeline-copy" });
		const title = copy.createDiv({ cls: "obsync-timeline-title" });
		title.createSpan({ cls: "obsync-history-row-title", text: row.title });
		if (row.isLatest)
			title.createSpan({ cls: "obsync-timeline-current", text: "Latest" });
		if (row.pinned) {
			const pin = title.createSpan({
				cls: "obsync-timeline-icon obsync-history-pinned-badge",
			});
			setIcon(pin, "pin");
			pin.setAttr("aria-label", "Pinned snapshot");
		}
		copy.createDiv({ cls: "obsync-history-row-meta", text: row.meta });
		renderSize(head, row.size, row.sizeDelta);
		const actions = head.createDiv({ cls: "obsync-timeline-actions" });
		appendIconButton(actions, "ellipsis", "Version actions", (event) => {
			event.stopPropagation();
			this.showRowMenu(event, path, row);
		});
		head.addEventListener("contextmenu", (event) => {
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

	private renderBackButton(header: HTMLElement, path: string): void {
		const currentPath = this.currentFilePath();
		const canGoBack =
			this.explicitPath !== null &&
			currentPath !== null &&
			currentPath !== path;
		if (!canGoBack) return;
		appendLabeledButton(header, "arrow-left", "Back to current file", () => {
			this.setPath(null);
			this.onRerender();
		});
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
