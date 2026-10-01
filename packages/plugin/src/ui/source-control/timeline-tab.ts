import { setIcon } from "obsidian";
import type { PluginHost } from "@/plugin/host";
import { errorMessage } from "@/shared";
import type { SnapshotListResult } from "@/sync/history";
import {
	appendIconButton,
	appendLabeledButton,
	makeActivatable,
	notifyError,
	onLongPress,
} from "@/ui/common";
import type { HistoryDiffTarget } from "@/ui/source-control-view";
import { groupByDay } from "./day-groups";
import { STATUS_CLASSES, STATUS_LETTERS } from "./row-formatter";
import { RowPager } from "./row-pager";
import { renderPath, renderSize } from "./row-parts";
import { TimelineActions } from "./timeline-actions";
import {
	buildTimelineRows,
	type TimelineFileRow,
	type TimelineRow,
	timelineDiffTarget,
} from "./timeline-rows";

export class TimelineTab {
	private snapshots: SnapshotListResult | null = null;
	private error: string | null = null;
	private loading = false;
	private generation = 0;
	private openGeneration = 0;
	private readonly expanded = new Set<string>();
	private readonly pages = new Map<string, RowPager>();
	private selected: string | null = null;
	private opening: string | null = null;
	private list: HTMLElement | null = null;
	private scrollTop = 0;
	private focusKey: string | null = null;
	private readonly actions: TimelineActions;

	constructor(
		private readonly plugin: PluginHost,
		private readonly onRerender: () => void,
		private readonly openDiff: (
			path: string,
			history: HistoryDiffTarget,
		) => Promise<void>,
		onSnapshotsChanged: () => void,
	) {
		this.actions = new TimelineActions(
			plugin,
			onSnapshotsChanged,
			(row, file, mode) => void this.openFile(row, file, mode),
		);
	}

	captureState(): void {
		if (
			!this.list?.isConnected ||
			this.list.hasClass("is-loading") ||
			!this.snapshots
		)
			return;
		this.scrollTop = this.list.scrollTop;
		const active = this.list.ownerDocument.activeElement;
		this.focusKey =
			active && this.list.contains(active)
				? active.getAttribute("data-timeline-focus")
				: null;
	}

	clear(): void {
		this.captureState();
		this.snapshots = null;
		this.error = null;
		this.loading = false;
		this.generation++;
	}

	dispose(): void {
		this.generation++;
		this.openGeneration++;
		this.list = null;
	}

	render(parent: HTMLElement): void {
		const pane = parent.createDiv({
			cls: "obsync-history-pane obsync-timeline",
		});
		if (!this.plugin.settings.fileHistoryEnabled) {
			pane.createDiv({
				cls: "obsync-status-line",
				text: "File version history is disabled. Enable it in settings to see the timeline.",
			});
			return;
		}
		const head = pane.createDiv({ cls: "obsync-history-versions-head" });
		const bar = head.createDiv({ cls: "obsync-history-head-actions" });
		appendLabeledButton(bar, "refresh-cw", "Refresh timeline", () => {
			this.clear();
			this.onRerender();
		});
		this.list = pane.createDiv({
			cls: "obsync-history-list obsync-timeline-list",
		});
		this.list.toggleClass("is-loading", this.snapshots === null);
		this.renderBody(this.list);
		if (this.snapshots) {
			this.list.scrollTop = this.scrollTop;
			if (this.focusKey) {
				const target = Array.from(
					this.list.querySelectorAll<HTMLElement>("[data-timeline-focus]"),
				).find(
					(el) => el.getAttribute("data-timeline-focus") === this.focusKey,
				);
				target?.focus({ preventScroll: true });
				this.focusKey = null;
			}
		}
	}

	private renderBody(body: HTMLElement): void {
		if (this.error) {
			body.createDiv({
				cls: "obsync-history-error",
				text: `Could not load the timeline: ${this.error}`,
			});
			return;
		}
		if (!this.snapshots) {
			body.createDiv({ cls: "obsync-status-line", text: "Loading…" });
			this.load();
			return;
		}
		if (this.snapshots.lagging) {
			body.createDiv({
				cls: "obsync-status-line",
				text: "History has not caught up with the latest push yet, so the newest snapshot is missing.",
			});
		}
		const rows = buildTimelineRows(this.snapshots.snapshots, {
			currentDevice: this.plugin.controller.currentDevice(),
		});
		if (rows.length === 0) {
			body.createDiv({
				cls: "obsync-status-line is-empty",
				text: "No pushes recorded yet. The timeline fills up as you push.",
			});
		}
		for (const group of groupByDay(rows)) {
			body.createDiv({ cls: "obsync-timeline-day", text: group.label });
			for (const row of group.rows) this.renderRow(body, row);
		}
	}

	private load(): void {
		if (this.loading) return;
		this.loading = true;
		const generation = this.generation;
		void this.plugin.controller.history
			.listSnapshots()
			.then((result) => {
				if (generation !== this.generation) return;
				this.snapshots = result;
				const ids = new Set(result.snapshots.map((row) => row.id));
				for (const id of this.expanded)
					if (!ids.has(id)) this.expanded.delete(id);
				for (const id of this.pages.keys())
					if (!ids.has(id)) this.pages.delete(id);
			})
			.catch((error: unknown) => {
				if (generation === this.generation) this.error = errorMessage(error);
			})
			.finally(() => {
				if (generation !== this.generation) return;
				this.loading = false;
				this.onRerender();
			});
	}

	private renderRow(body: HTMLElement, row: TimelineRow): void {
		const expanded = this.expanded.has(row.snapshotId);
		const card = body.createDiv({ cls: "obsync-timeline-card" });
		const head = card.createDiv({ cls: "obsync-timeline-head" });
		head.setAttr("data-timeline-focus", row.snapshotId);
		head.setAttr("aria-expanded", String(expanded));
		makeActivatable(head, `${row.title} · ${row.tooltip}`, () => {
			if (expanded) this.expanded.delete(row.snapshotId);
			else this.expanded.add(row.snapshotId);
			this.onRerender();
		});
		const chevron = head.createSpan({ cls: "obsync-timeline-icon" });
		setIcon(chevron, expanded ? "chevron-down" : "chevron-right");
		const copy = head.createDiv({ cls: "obsync-timeline-copy" });
		const title = copy.createDiv({ cls: "obsync-timeline-title" });
		title.createSpan({ cls: "obsync-history-row-title", text: row.title });
		if (row.isHead)
			title.createSpan({ cls: "obsync-timeline-current", text: "Latest push" });
		if (row.pinned) {
			const pin = title.createSpan({
				cls: "obsync-timeline-icon obsync-history-pinned-badge",
			});
			setIcon(pin, "pin");
			pin.setAttr("aria-label", "Pinned snapshot");
		}
		copy.createDiv({
			cls: "obsync-history-row-meta",
			text: [row.meta, row.counts ?? "Change record unavailable", row.netSize]
				.filter((part): part is string => part !== null)
				.join(" · "),
		});
		const actions = head.createDiv({ cls: "obsync-timeline-actions" });
		const more = appendIconButton(
			actions,
			"ellipsis",
			"Snapshot actions",
			(event) => {
				event.stopPropagation();
				this.actions.showSnapshotMenu(event, row);
			},
		);
		more.setAttr("data-timeline-focus", `${row.snapshotId}:menu`);
		head.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			this.actions.showSnapshotMenu(event, row);
		});
		if (!expanded) return;
		const list = card.createDiv({ cls: "obsync-timeline-files" });
		if (!row.files || row.files.length === 0) {
			list.createDiv({
				cls: "obsync-status-line",
				text: row.files
					? "No file changes in this push."
					: "The change record for this push is unavailable.",
			});
			return;
		}
		let pager = this.pages.get(row.snapshotId);
		if (!pager) {
			pager = new RowPager();
			this.pages.set(row.snapshotId, pager);
		}
		for (const file of pager.slice(row.files)) this.renderFile(list, row, file);
		pager.render(list, row.files.length, this.onRerender);
	}

	private renderFile(
		parent: HTMLElement,
		row: TimelineRow,
		file: TimelineFileRow,
	): void {
		const key = JSON.stringify([row.snapshotId, file.path]);
		const item = parent.createDiv({
			cls: "obsync-file-row obsync-timeline-file",
		});
		item.setAttr("data-timeline-focus", key);
		item.toggleClass("is-active", this.selected === key);
		item.toggleClass("is-opening", this.opening === key);
		if (this.selected === key) item.setAttr("aria-current", "true");
		if (this.opening === key) item.setAttr("aria-busy", "true");
		// Before makeActivatable: the hold has to swallow its own trailing click.
		onLongPress(item, (event) => this.actions.showFileMenu(event, row, file));
		makeActivatable(item, file.path, () => void this.openFile(row, file));
		const icon = item.createSpan({ cls: "obsync-timeline-icon" });
		setIcon(icon, "file-text");
		renderPath(item, file.path);
		renderSize(item, file.size, file.sizeDelta);
		item.createSpan({
			cls: `obsync-file-status ${STATUS_CLASSES[file.action]}`,
			text: STATUS_LETTERS[file.action],
		});
		const actions = item.createDiv({ cls: "obsync-timeline-actions" });
		const more = appendIconButton(
			actions,
			"ellipsis",
			`Actions for ${file.path}`,
			(event) => {
				event.stopPropagation();
				this.actions.showFileMenu(event, row, file);
			},
		);
		more.setAttr("data-timeline-focus", `${key}:menu`);
		item.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			this.actions.showFileMenu(event, row, file);
		});
	}

	private async openFile(
		row: TimelineRow,
		file: TimelineFileRow,
		mode: "current" | "change" = "current",
	): Promise<void> {
		const generation = ++this.openGeneration;
		this.selected = JSON.stringify([row.snapshotId, file.path]);
		this.opening = this.selected;
		this.onRerender();
		try {
			await this.openDiff(file.path, timelineDiffTarget(file, mode));
		} catch (error) {
			if (generation === this.openGeneration)
				notifyError("Could not open historical file", error);
		} finally {
			if (generation === this.openGeneration) {
				this.opening = null;
				this.onRerender();
			}
		}
	}
}
