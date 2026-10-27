import { setIcon } from "obsidian";
import type { PluginHost } from "@/app/host";
import { formatBytes } from "@/core/shared";
import {
	appendIconButton,
	callout,
	makeActivatable,
	notifyError,
	onLongPress,
	renderPath,
} from "@/core/ui";
import type { HistoryDiffTarget } from "@/features/diff";
import type { SnapshotListResult } from "@/features/sync";
import { STATUS_CLASSES, STATUS_LETTERS } from "../changes/row-formatter";
import { groupRows } from "../history/day-groups";
import { HistoryList } from "../history/history-list";
import { RowPager } from "../history/row-pager";
import { renderDelta } from "../row-parts";
import {
	renderEmptyState,
	renderHistoryOff,
	renderLoadError,
	renderLoading,
} from "../tab-states";
import { TimelineActions } from "./timeline-actions";
import {
	buildTimelineRows,
	type TimelineFileRow,
	type TimelineRow,
	timelineDiffTarget,
} from "./timeline-rows";

export class TimelineTab {
	private readonly snapshots = new HistoryList<SnapshotListResult>(() => {
		const loaded = this.snapshots.value;
		if (loaded) this.prune(loaded);
		this.onRerender();
	});
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
			!this.snapshots.value
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
		this.snapshots.clear();
	}

	clearOffline(): boolean {
		if (!this.snapshots.offline) return false;
		this.clear();
		return true;
	}

	dispose(): void {
		this.snapshots.clear();
		this.openGeneration++;
		this.list = null;
	}

	render(parent: HTMLElement, tools: HTMLElement): void {
		const pane = parent.createDiv({
			cls: "mdsync-history-pane mdsync-timeline",
		});
		if (!this.plugin.settings.fileHistoryEnabled) {
			renderHistoryOff(
				pane,
				this.plugin.app,
				"File version history is disabled. Enable it in settings to see the timeline.",
			);
			return;
		}
		appendIconButton(tools, "refresh-cw", "Refresh timeline", () =>
			this.reload(),
		);
		this.list = pane.createDiv({
			cls: "mdsync-history-list mdsync-timeline-list",
		});
		this.list.toggleClass("is-loading", this.snapshots.value === null);
		this.renderBody(this.list);
		if (this.snapshots.value) {
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

	private reload(): void {
		this.clear();
		this.onRerender();
	}

	private renderBody(body: HTMLElement): void {
		const { value: snapshots, error } = this.snapshots;
		if (error) {
			renderLoadError(body, "Could not load the timeline", error, () =>
				this.reload(),
			);
			return;
		}
		if (!snapshots) {
			renderLoading(body);
			this.snapshots.load(() => this.plugin.controller.history.listSnapshots());
			return;
		}
		if (snapshots.lagging) {
			callout(
				body,
				"warning",
				"History has not caught up with the latest push yet, so the newest snapshot is missing.",
			);
		}
		const rows = buildTimelineRows(snapshots.snapshots, {
			currentDevice: this.plugin.controller.currentDevice(),
		});
		if (rows.length === 0 && !snapshots.lagging) {
			renderEmptyState(body, {
				icon: "clock-3",
				title: "No pushes yet",
				text: "No pushes recorded yet. The timeline fills up as you push.",
			});
		}
		for (const group of groupRows(rows)) {
			body.createDiv({ cls: "mdsync-timeline-day", text: group.label });
			for (const row of group.rows) this.renderRow(body, row);
		}
	}

	/** Rows gone from the new list take their open state with them. */
	private prune({ snapshots }: SnapshotListResult): void {
		const ids = new Set(snapshots.map((row) => row.id));
		for (const id of this.expanded) if (!ids.has(id)) this.expanded.delete(id);
		for (const id of this.pages.keys()) if (!ids.has(id)) this.pages.delete(id);
	}

	private renderRow(body: HTMLElement, row: TimelineRow): void {
		const expanded = this.expanded.has(row.snapshotId);
		const card = body.createDiv({ cls: "mdsync-timeline-card" });
		const head = card.createDiv({ cls: "mdsync-timeline-head" });
		head.setAttr("data-timeline-focus", row.snapshotId);
		head.setAttr("aria-expanded", String(expanded));
		makeActivatable(head, `${row.title} · ${row.tooltip}`, () => {
			if (expanded) this.expanded.delete(row.snapshotId);
			else this.expanded.add(row.snapshotId);
			this.onRerender();
		});
		const chevron = head.createSpan({ cls: "mdsync-timeline-icon" });
		setIcon(chevron, expanded ? "chevron-down" : "chevron-right");
		const copy = head.createDiv({ cls: "mdsync-timeline-copy" });
		const title = copy.createDiv({ cls: "mdsync-timeline-title" });
		title.createSpan({ cls: "mdsync-history-row-title", text: row.title });
		if (row.isHead)
			title.createSpan({ cls: "mdsync-pill", text: "Latest push" });
		if (row.pinned) {
			const pin = title.createSpan({ cls: "mdsync-history-pin" });
			setIcon(pin, "pin");
			pin.setAttr("aria-label", "Pinned snapshot");
		}
		this.renderMeta(copy, row);
		const actions = head.createDiv({ cls: "mdsync-timeline-actions" });
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
		const list = card.createDiv({ cls: "mdsync-timeline-files" });
		if (!row.files || row.files.length === 0) {
			list.createDiv({
				cls: "mdsync-status-line",
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

	/** Who pushed, a chip per kind of change and the net size. */
	private renderMeta(parent: HTMLElement, row: TimelineRow): void {
		const meta = parent.createDiv({
			cls: "mdsync-history-row-meta mdsync-timeline-meta",
		});
		meta.createSpan({ cls: "mdsync-timeline-device", text: row.meta });
		if (!row.tally) {
			meta.createSpan({ text: "Change record unavailable" });
			return;
		}
		const chips = meta.createSpan({ cls: "mdsync-timeline-chips" });
		if (row.counts) chips.setAttr("aria-label", row.counts);
		for (const [action, count] of row.tally) {
			chips.createSpan({
				cls: `mdsync-count-chip ${STATUS_CLASSES[action]}`,
				text: `${STATUS_LETTERS[action]} ${count}`,
			});
		}
		if (row.netDelta) renderDelta(meta, row.netDelta, "mdsync-timeline-net");
	}

	private renderFile(
		parent: HTMLElement,
		row: TimelineRow,
		file: TimelineFileRow,
	): void {
		const key = JSON.stringify([row.snapshotId, file.path]);
		const item = parent.createDiv({
			cls: "mdsync-file-row mdsync-timeline-file",
		});
		item.toggleClass("is-deleted", file.action === "delete");
		item.setAttr("data-timeline-focus", key);
		item.toggleClass("is-active", this.selected === key);
		item.toggleClass("is-opening", this.opening === key);
		if (this.selected === key) item.setAttr("aria-current", "true");
		if (this.opening === key) item.setAttr("aria-busy", "true");
		// Before makeActivatable: the hold has to swallow its own trailing click.
		onLongPress(item, (event) => this.actions.showFileMenu(event, row, file));
		makeActivatable(item, file.path, () => void this.openFile(row, file));
		renderPath(item, file.path);
		// What a change moved; an addition, a deletion or an even change shows its size.
		if (file.sizeDelta)
			renderDelta(item, file.sizeDelta, "mdsync-timeline-size");
		else
			item.createSpan({
				cls: "mdsync-timeline-size",
				text: formatBytes(file.size),
			});
		item.createSpan({
			cls: `mdsync-file-status ${STATUS_CLASSES[file.action]}`,
			text: STATUS_LETTERS[file.action],
		});
		const actions = item.createDiv({ cls: "mdsync-timeline-actions" });
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
