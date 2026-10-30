import { Menu, setIcon } from "obsidian";
import { HISTORY_KEEP_MS } from "@/core/constants";
import { openPluginSettings } from "@/core/hub";
import { formatDay, pluralize } from "@/core/shared";
import {
	appendIconButton,
	appendLabeledButton,
	attempt,
	makeActivatable,
} from "@/core/ui";
import type { HistoryDiffTarget } from "@/features/diff";
import { countsBefore, type FileVersion } from "@/features/sync";
import type { SourceControlHost } from "../host";
import { confirmAndRestoreFile } from "../restore-file";
import { renderAgeHeader, renderSize } from "../row-parts";
import {
	renderEmptyState,
	renderHistoryOff,
	renderLoadError,
	renderLoading,
} from "../tab-states";
import { addSnapshotPinItems } from "../timeline/snapshot-menu";
import { groupByAge } from "./age-groups";
import { HistoryList } from "./history-list";
import { buildHistoryRows, type HistoryRow } from "./history-rows";
import { RowPager } from "./row-pager";

export class HistoryTab {
	private explicitPath: string | null = null;
	private readonly versions = new HistoryList<FileVersion[]>(() =>
		this.onRerender(),
	);
	/** The version whose diff was opened last. */
	private selected: string | null = null;
	private loadedPath: string | null = null;
	private pager = new RowPager();

	constructor(
		private readonly plugin: SourceControlHost,
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
		this.versions.clear();
		this.loadedPath = null;
		// A new path or result always follows a clear.
		this.pager = new RowPager();
	}

	clearOffline(): boolean {
		if (!this.versions.offline) return false;
		this.clearVersions();
		return true;
	}

	render(parent: HTMLElement, tools: HTMLElement): void {
		const pane = parent.createDiv({ cls: "mdsync-history-pane" });
		if (!this.plugin.settings.fileHistoryEnabled) {
			renderHistoryOff(
				pane,
				this.plugin.app,
				"History is off. Turn on History in MDSync settings.",
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
		const { value: versions, error } = this.versions;
		if (error) {
			renderLoadError(body, "Could not load history", error, () =>
				this.reload(),
			);
			return;
		}
		if (versions === null) {
			renderLoading(body);
			this.versions.load(() =>
				this.plugin.controller.history.getFileHistory(path),
			);
			return;
		}
		if (versions.length === 0) {
			renderEmptyState(body, {
				icon: "history",
				title: "No versions yet",
				text: "No stored history for this file yet.",
			});
			return;
		}
		// Pinned lead, as groupByAge orders them, so a page break never splits the pinned group.
		const ordered = [
			...versions.flatMap((v, index) => (v.pinId !== null ? [index] : [])),
			...versions.flatMap((v, index) => (v.pinId === null ? [index] : [])),
		];
		const rows = buildHistoryRows(versions, {
			currentDevice: this.plugin.controller.currentDevice(),
			only: this.pager.slice(ordered),
		});
		for (const group of groupByAge(rows)) {
			renderAgeHeader(body, group);
			const list = body.createDiv({ cls: "mdsync-history-rows" });
			for (const row of group.rows) this.renderRow(list, path, row);
		}
		this.pager.render(body, ordered.length, this.onRerender);
		this.renderFooter(body);
	}

	/** Where the list ends and why: this device's **Keep history for**. */
	private renderFooter(body: HTMLElement): void {
		const horizon = HISTORY_KEEP_MS[this.plugin.settings.fileHistoryKeep];
		const note = body.createDiv({ cls: "mdsync-history-footer" });
		if (horizon === null) {
			note.setText(
				"Older versions thin to one per week and are kept for good.",
			);
			return;
		}
		const now = Date.now();
		const cutoff = countsBefore(now, horizon);
		note.appendText(
			`Older versions thin out with age; before ${formatDay(cutoff, now, false)} only pinned versions and activity counts remain. `,
		);
		note
			.createEl("a", { text: "Keep history for", href: "#" })
			.addEventListener("click", (event) => {
				event.preventDefault();
				openPluginSettings(this.plugin.app);
			});
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
		const count = this.versions.value?.length;
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

	/** A dot on the day's line, or a pin; the size this version weighed. */
	private renderRow(list: HTMLElement, path: string, row: HistoryRow): void {
		const item = list.createDiv({ cls: "mdsync-history-row" });
		item.toggleClass("is-latest", row.isLatest);
		item.toggleClass("is-active", this.selected === row.snapshotId);
		const label = [row.title, row.tooltip, row.meta]
			.filter(Boolean)
			.join(" · ");
		makeActivatable(item, label, () => {
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
			mark.addClass("has-pin");
			const pin = mark.createSpan({ cls: "mdsync-history-pin" });
			setIcon(pin, "pin");
			pin.setAttr("aria-label", "Pinned version");
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
		addSnapshotPinItems(
			menu,
			this.plugin,
			{ ...row, snapshotId: row.pinId ?? row.snapshotId, path },
			this.onSnapshotsChanged,
			row.replayable,
		);
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
		await confirmAndRestoreFile(
			this.plugin,
			{
				path,
				target: path,
				// The title is a clock time under its day; the dialog has no day.
				version: { ...row.version, label: row.label || row.version.label },
			},
			// The list describes the remote, which a local restore does not touch.
			"Restored. Review and push the change when ready.",
		);
	}
}
