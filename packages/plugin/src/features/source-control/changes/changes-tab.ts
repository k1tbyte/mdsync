import { Platform, SearchComponent } from "obsidian";
import type { PluginHost } from "@/app/host";
import { appendIconButton, appendLabeledButton, notifyError } from "@/core/ui";
import { lastEditLabel, lastEditor } from "@/features/spaces";
import type {
	DiffResult,
	ManifestEntry,
	SyncStatusSnapshot,
} from "@/features/sync";
import { canSync } from "@/features/sync";
import type { SourceControlActions } from "../actions/actions";
import { SelectionBar } from "../actions/selection-bar";
import { renderSetupPrompt } from "../setup-prompt";
import { SummaryCard } from "../summary-card";
import { ESection, type FileRow } from "../types";
import { ChangesSection, type ChangesSectionDeps } from "./changes-section";
import type { ConflictPreviewManager } from "./conflict-preview-manager";
import { diffEquals } from "./diff-identity";
import { foldMoves, rowFromChange, rowFromConflict } from "./row-formatter";

/** Summary, filter, the three change sections and the selection bar; owns selection and layout so the view above only picks a tab. */
export class ChangesTab {
	private layout: "tree" | "flat";
	private filter = "";
	/**
	 * What the pane was last built from. A compare returns a fresh result even when nothing moved, so the row fields
	 * are walked instead of compared by identity or described as a string (5.3 ms and 2.5 MB per broadcast at 20k).
	 */
	private lastDiff: DiffResult | null = null;
	private lastError: string | null = null;
	private setUp = false;
	private built = false;
	private summary: SummaryCard | null = null;
	private selectionBar: SelectionBar | null = null;
	private refreshButtonEl: HTMLButtonElement | null = null;
	private readonly sections: ChangesSection[];
	/** The pane scrolls, not the lists; every window is computed against it. */
	private scroller: HTMLElement | null = null;
	private activePath: string | null = null;
	/** What had focus in the lists when a sync locked them. */
	private lockedFocus: HTMLElement | null = null;
	private openingPath: string | null = null;
	private openGeneration = 0;

	constructor(
		private readonly plugin: PluginHost,
		private readonly previews: ConflictPreviewManager,
		private readonly actions: SourceControlActions,
		private readonly rerender: () => void,
		private readonly openDiff: (path: string) => Promise<void>,
		openMerge: (path: string) => void,
	) {
		this.layout = plugin.settings.uiLayout;
		const isBusy = (): boolean => plugin.controller.getSnapshot().busy;
		const deps: ChangesSectionDeps = {
			scroller: () => this.scroller,
			layout: () => this.layout,
			isBusy,
			refreshLists: () => this.refreshLists(),
			selectionChanged: () => this.selectionBar?.update(isBusy()),
			actions,
			previews,
			rerender,
			openFileDiff: (item, path) => this.openFileDiff(item, path),
			openMerge,
			isOpening: (path) => this.openingPath === path,
			isActive: (path) => this.activePath === path,
			editLabel: (path) => lastEditLabel(plugin, path),
			editor: (path) => lastEditor(plugin, path),
		};
		this.sections = [
			new ChangesSection(ESection.Conflicts, "Conflicts", deps),
			new ChangesSection(ESection.Local, "Local changes", deps),
			new ChangesSection(ESection.Remote, "Remote changes", deps),
		];
	}

	/** Virtual lists listen on the scroller, which outlives their own rows. */
	dispose(): void {
		this.openGeneration++;
		this.openingPath = null;
		for (const section of this.sections) section.destroyList();
	}

	invalidate(): void {
		this.built = false;
	}

	/** True when the tree itself changed; otherwise only status needs touching. */
	needsRebuild(snapshot: SyncStatusSnapshot): boolean {
		return (
			!this.built ||
			canSync(this.plugin.settings) !== this.setUp ||
			(snapshot.error ?? null) !== this.lastError ||
			!diffEquals(this.lastDiff, snapshot.result?.diff ?? null)
		);
	}

	/** In-place updates to status/progress keep scrolling usable mid-push. */
	refreshTimes(): void {
		this.summary?.refreshTimes();
	}

	refreshInPlace(snapshot: SyncStatusSnapshot): void {
		const { busy } = snapshot;
		this.summary?.update(snapshot);
		if (this.refreshButtonEl) this.refreshButtonEl.disabled = busy;
		this.scroller?.toggleClass("is-busy", busy);
		this.lockLists(snapshot.cancellable);
		for (const section of this.sections) section.updateUi(busy);
		this.selectionBar?.update(busy);
		// The summary grows notes and buttons, which move the lists below it.
		this.refreshLists();
	}

	/** While files move the lists are dimmed and inert: a click would only queue behind the sync. */
	private lockLists(locked: boolean): void {
		const scroller = this.scroller;
		if (!scroller) return;
		const sections = [
			...scroller.querySelectorAll<HTMLElement>(".mdsync-section"),
		];
		const focused = activeDocument.activeElement;
		if (locked && sections.some((section) => section.contains(focused))) {
			// Inert drops focus to the body; the pane keeps the keyboard, and gets the row back after.
			this.lockedFocus = focused as HTMLElement;
			scroller.tabIndex = -1;
			scroller.focus({ preventScroll: true });
		}
		for (const section of sections) section.inert = locked;
		if (locked || !this.lockedFocus) return;
		if (
			this.lockedFocus.isConnected &&
			activeDocument.activeElement === scroller
		) {
			this.lockedFocus.focus({ preventScroll: true });
		}
		this.lockedFocus = null;
	}

	/** Re-windows every list against where it now sits in the pane. */
	refreshLists(): void {
		for (const section of this.sections) section.refreshList();
	}

	/** `tools` is the tab row's trailing slot; `overlay` holds the selection bar over the pane, outside its scroll. */
	render(
		root: HTMLElement,
		snapshot: SyncStatusSnapshot,
		tools: HTMLElement,
		overlay: HTMLElement,
	): void {
		this.dispose();
		this.scroller = root;
		if (this.needsRebuild(snapshot)) this.previews.clearCache();
		this.built = true;
		this.lastDiff = snapshot.result?.diff ?? null;
		this.lastError = snapshot.error ?? null;
		this.selectionBar = null;
		overlay.removeClass("has-selection");
		this.summary = null;
		this.refreshButtonEl = null;
		root.addClass("mdsync-changes-panel");
		root.toggleClass("is-busy", snapshot.busy);
		this.setUp = canSync(this.plugin.settings);
		if (!this.setUp) {
			renderSetupPrompt(root, this.plugin);
			return;
		}
		// A phone's tab row has room only for the tabs' names; Push and Pull dock under the thumb.
		const phone = Platform.isPhone;
		this.summary = new SummaryCard(
			root,
			this.plugin,
			this.actions,
			phone ? overlay : undefined,
		);
		this.renderTools(
			phone ? this.summary.toolsEl : tools,
			snapshot.busy,
			phone,
		);
		this.summary.update(snapshot);

		const result = snapshot.result;
		const diff = result?.diff;
		if (!diff) return;
		const localFiles = result.snapshot.files;
		const remoteFiles = result.remote?.files;
		const showFileSizes = this.plugin.settings.showFileSizes;
		const sizeIn = (
			files: Record<string, ManifestEntry> | undefined,
			path: string,
		): number | undefined => (showFileSizes ? files?.[path]?.size : undefined);
		const rows: Record<ESection, FileRow[]> = {
			[ESection.Conflicts]: diff.conflicts.map((conflict) =>
				rowFromConflict(
					conflict,
					sizeIn(localFiles, conflict.path) ??
						sizeIn(remoteFiles, conflict.path),
				),
			),
			[ESection.Local]: foldMoves(diff.localChanges, diff.moves, (change) =>
				rowFromChange(
					change,
					sizeIn(localFiles, change.path) ?? sizeIn(remoteFiles, change.path),
					sizeIn(remoteFiles, change.path),
				),
			),
			[ESection.Remote]: foldMoves(diff.remoteChanges, diff.moves, (change) =>
				rowFromChange(
					change,
					sizeIn(remoteFiles, change.path) ?? sizeIn(localFiles, change.path),
					sizeIn(localFiles, change.path),
				),
			),
		};
		this.previews.prune(rows[ESection.Conflicts].map((row) => row.path));
		const total = this.sections.reduce((n, s) => n + rows[s.id].length, 0);
		if (total > 0) this.renderFilter(root);
		let shown = 0;
		for (const section of this.sections) {
			// Pruned against the unfiltered rows: a filter must not drop a selection.
			section.pruneSelection(rows[section.id]);
			const visible = this.applyFilter(rows[section.id]);
			shown += visible.length;
			section.render(root, visible, snapshot.busy);
		}
		this.lockLists(snapshot.cancellable);
		if (total > 0 && shown === 0) {
			root.createDiv({
				cls: "mdsync-status-line is-empty",
				text: "No changed files match the filter.",
			});
		}
		this.selectionBar = new SelectionBar(overlay, this.sections);
		this.selectionBar.update(snapshot.busy);
	}

	/** `named`: a phone's tools fill a row of the summary, so they show short names. */
	private renderTools(tools: HTMLElement, busy: boolean, named: boolean): void {
		const add = (
			icon: string,
			label: string,
			name: string,
			run: () => void,
		): HTMLButtonElement =>
			named
				? appendLabeledButton(tools, icon, name, run)
				: appendIconButton(tools, icon, label, run);
		this.refreshButtonEl = add(
			"refresh-cw",
			"Refresh changes",
			"Refresh",
			() => void this.plugin.controller.refreshFromDisk(),
		);
		this.refreshButtonEl.disabled = busy;
		const tree = this.layout === "tree";
		add(
			tree ? "list" : "list-tree",
			tree ? "Show flat list" : "Show folder tree",
			tree ? "List" : "Tree",
			() => {
				this.layout = tree ? "flat" : "tree";
				this.plugin.settings.uiLayout = this.layout;
				void this.plugin.saveSettings();
				this.rerender();
			},
		);
	}

	private applyFilter(rows: ReadonlyArray<FileRow>): ReadonlyArray<FileRow> {
		const needle = this.filter.trim().toLowerCase();
		if (!needle) return rows;
		return rows.filter((row) => row.path.toLowerCase().includes(needle));
	}

	/** Narrows the lists without touching selection, so a filter never silently shrinks what an action does. */
	private renderFilter(parent: HTMLElement): void {
		const search = new SearchComponent(
			parent.createDiv({ cls: "mdsync-changes-filter" }),
		)
			.setPlaceholder("Filter by path…")
			.setValue(this.filter);
		const input = search.inputEl;
		input.setAttr("aria-label", "Filter changed files by path");
		const apply = (): void => {
			this.filter = input.value;
			const caret = input.selectionStart ?? input.value.length;
			this.invalidate();
			this.rerender();
			// The re-render replaced this node; carry focus and caret to the new one.
			const next = this.scroller?.querySelector<HTMLInputElement>(
				".mdsync-changes-filter input",
			);
			if (!next) return;
			next.focus();
			next.setSelectionRange(caret, caret);
		};
		// Replaced mid-composition, the input would drop what the IME holds.
		let composing = false;
		input.addEventListener("compositionstart", () => {
			composing = true;
		});
		input.addEventListener("compositionend", () => {
			composing = false;
			apply();
		});
		search.onChange(() => {
			if (!composing) apply();
		});
	}

	private openFileDiff(item: HTMLElement, path: string): void {
		if (this.openingPath === path) return;
		const generation = ++this.openGeneration;
		this.openingPath = path;
		item.addClass("is-opening");
		item.setAttr("aria-busy", "true");
		void this.openDiff(path)
			.then(() => {
				if (generation !== this.openGeneration) return;
				this.activePath = path;
				this.scroller
					?.querySelectorAll(".mdsync-file-row.is-active")
					.forEach((row) => {
						row.removeClass("is-active");
						row.removeAttribute("aria-current");
					});
				const current = this.findRenderedFileRow(path);
				current?.addClass("is-active");
				current?.setAttr("aria-current", "true");
			})
			.catch((err: unknown) => {
				if (generation === this.openGeneration) {
					notifyError("Could not open diff", err);
				}
			})
			.finally(() => {
				if (generation !== this.openGeneration) return;
				this.openingPath = null;
				const current = this.findRenderedFileRow(path);
				current?.removeClass("is-opening");
				current?.removeAttribute("aria-busy");
			});
	}

	private findRenderedFileRow(path: string): HTMLElement | null {
		const rows =
			this.scroller?.querySelectorAll<HTMLElement>(".mdsync-file-row") ?? [];
		for (const row of rows) {
			if (row.dataset.mdsyncPath === path) return row;
		}
		return null;
	}
}
