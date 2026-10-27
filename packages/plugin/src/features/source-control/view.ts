import {
	type App,
	ItemView,
	Platform,
	setIcon,
	type WorkspaceLeaf,
} from "obsidian";
import type { PluginHost } from "@/app/host";
import {
	RELATIVE_TIME_REFRESH_MS,
	SOURCE_CONTROL_VIEW_TYPE,
} from "@/core/constants";
import { redrawOnPhoneChange } from "@/core/ui";
import { openDiffView } from "@/features/diff";
import type { SyncStatusSnapshot } from "@/features/sync";
import { canSync } from "@/features/sync";
import { SourceControlActions } from "./actions/actions";
import { ChangesTab } from "./changes/changes-tab";
import { ConflictPreviewManager } from "./changes/conflict-preview-manager";
import { HistoryTab } from "./history/history-tab";
import { TimelineTab } from "./timeline/timeline-tab";
import { TrashTab } from "./trash/trash-tab";

const ESourceTab = {
	Changes: "changes",
	History: "history",
	Deleted: "deleted",
	Timeline: "timeline",
} as const;
type ESourceTab = (typeof ESourceTab)[keyof typeof ESourceTab];

const SOURCE_TAB_PANEL_ID = "mdsync-source-tab-panel";

const SOURCE_TABS: ReadonlyArray<{
	tab: ESourceTab;
	label: string;
	icon: string;
}> = [
	{ tab: ESourceTab.Changes, label: "Changes", icon: "list-tree" },
	{ tab: ESourceTab.History, label: "History", icon: "history" },
	{ tab: ESourceTab.Deleted, label: "Deleted", icon: "trash-2" },
	{ tab: ESourceTab.Timeline, label: "Timeline", icon: "clock-3" },
];

export function openSourceControlHistory(
	plugin: PluginHost,
	path?: string,
): Promise<void> {
	return openSourceControlOn(plugin, (view) => view.showHistory(path ?? null));
}

export function openSourceControlDeleted(plugin: PluginHost): Promise<void> {
	return openSourceControlOn(plugin, (view) => view.showDeleted());
}

/** An open view keeps its tab; conflicts are only on Changes. */
export function openSourceControlChanges(plugin: PluginHost): Promise<void> {
	return openSourceControlOn(plugin, (view) => view.showChanges());
}

async function openSourceControlOn(
	plugin: PluginHost,
	show: (view: SourceControlView) => void,
): Promise<void> {
	// The leaf it showed: an older one in a main tab may sit beside the sidebar's.
	const { view } = await openSourceControlView(
		plugin.app,
		SOURCE_CONTROL_VIEW_TYPE,
	);
	if (view instanceof SourceControlView) show(view);
}

export async function openSourceControlView(
	app: App,
	viewType: string,
): Promise<WorkspaceLeaf> {
	const { workspace } = app;
	const existing = workspace.getLeavesOfType(viewType);
	const shown =
		existing.find((leaf) => leaf.getRoot() === workspace.rightSplit) ??
		existing[0];
	if (shown) {
		await workspace.revealLeaf(shown);
		return shown;
	}
	const leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
	await leaf.setViewState({ type: viewType, active: true });
	await workspace.revealLeaf(leaf);
	return leaf;
}

/** A mobile's right sidebar lists only the views it holds: one waits there beside backlinks and the outline. */
export function keepInRightSidebar(app: App): void {
	const { workspace } = app;
	const held = workspace
		.getLeavesOfType(SOURCE_CONTROL_VIEW_TYPE)
		.some((leaf) => leaf.getRoot() === workspace.rightSplit);
	if (held) return;
	void workspace
		.getRightLeaf(false)
		?.setViewState({ type: SOURCE_CONTROL_VIEW_TYPE, active: false });
}

export class SourceControlView extends ItemView {
	private readonly plugin: PluginHost;
	private readonly previews: ConflictPreviewManager;
	private readonly actions: SourceControlActions;
	private readonly changes: ChangesTab;
	private root: HTMLElement | null = null;
	private unsubscribe: (() => void) | null = null;
	private tab: ESourceTab = ESourceTab.Changes;
	private historyTab!: HistoryTab;
	private trashTab!: TrashTab;
	private timelineTab!: TimelineTab;
	/** The file changed while the view was hidden; reloading then would fetch history nobody sees. */
	private historyStale = false;
	private comparedOnce = false;

	constructor(leaf: WorkspaceLeaf, plugin: PluginHost) {
		super(leaf);
		this.plugin = plugin;
		this.previews = new ConflictPreviewManager({
			loadPreview: (path) => this.plugin.controller.fileDiffs.getFileDiff(path),
		});
		this.actions = new SourceControlActions({
			plugin,
			showHistory: (path) => this.showHistory(path),
			openDiff: (path) => openDiffView(this.plugin, path),
		});
		this.changes = new ChangesTab(
			plugin,
			this.previews,
			this.actions,
			() => this.render(this.plugin.controller.getSnapshot(), true),
			(path) => openDiffView(this.plugin, path),
			(path) => void openDiffView(this.plugin, path, undefined, true),
		);
	}

	getViewType(): string {
		return SOURCE_CONTROL_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "MDSync source control";
	}

	getIcon(): string {
		return "refresh-cw";
	}

	async onOpen(): Promise<void> {
		this.historyTab = new HistoryTab(
			this.plugin,
			() => this.render(this.plugin.controller.getSnapshot(), true),
			(path, history) => openDiffView(this.plugin, path, history),
			() => this.showDeleted(),
			() => this.refreshHistory(),
		);
		this.trashTab = new TrashTab(
			this.plugin,
			() => this.render(this.plugin.controller.getSnapshot(), true),
			(path, history) => openDiffView(this.plugin, path, history),
		);
		this.timelineTab = new TimelineTab(
			this.plugin,
			() => this.render(this.plugin.controller.getSnapshot(), true),
			(path, history) => openDiffView(this.plugin, path, history),
			() => this.refreshHistory(),
		);
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (this.tab !== ESourceTab.History) return;
				if (!this.historyTab.isFollowingCurrentFile()) return;
				// Opening the diff itself fires this with no file; that is not a
				// reason to throw away the history the user just clicked into.
				if (!file) return;
				if (!this.containerEl.isShown()) {
					this.historyStale = true;
					return;
				}
				this.historyTab.clearVersions();
				this.render(this.plugin.controller.getSnapshot(), true);
			}),
		);
		this.root = this.contentEl;
		this.root.empty();
		this.root.addClass("mdsync-source-control");
		this.render(this.plugin.controller.getSnapshot(), true);
		redrawOnPhoneChange(this, () =>
			this.render(this.plugin.controller.getSnapshot(), true),
		);
		let revision = this.plugin.controller.getSnapshot().resultRevision;
		this.unsubscribe = this.plugin.controller.subscribe((snapshot) => {
			// A compare that went through proves the storage answers again.
			const compared =
				snapshot.resultRevision !== revision && !snapshot.offline;
			revision = snapshot.resultRevision;
			const reloaded = compared && this.clearOfflineLists();
			// Lists off screen load when their tab is next shown.
			if (reloaded && this.tab !== ESourceTab.Changes)
				this.render(snapshot, true);
			else this.render(snapshot);
		});
		this.registerInterval(
			window.setInterval(
				() => this.changes.refreshTimes(),
				RELATIVE_TIME_REFRESH_MS,
			),
		);
		this.compareOnceShown();
	}

	/**
	 * Its first compare waits until it shows: a leaf a mobile's sidebar made at launch must leave the startup
	 * sync to the scheduler. Not set up, the tab itself says so; a compare would only add a notice.
	 */
	private compareOnceShown(): void {
		if (this.comparedOnce || !this.containerEl.isShown()) return;
		this.comparedOnce = true;
		if (
			!this.plugin.controller.getSnapshot().result &&
			canSync(this.plugin.settings)
		) {
			void this.plugin.controller.refresh();
		}
	}

	onResize(): void {
		this.compareOnceShown();
		if (!this.historyStale || !this.containerEl.isShown()) return;
		this.historyStale = false;
		if (this.tab !== ESourceTab.History) return;
		this.historyTab.clearVersions();
		this.render(this.plugin.controller.getSnapshot(), true);
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		// Windowed lists listen on the active panel, which is about to be removed.
		this.changes.dispose();
		this.timelineTab.dispose();
		// A load still in flight will call back; without this it rebuilds a dead view.
		this.root = null;
		this.contentEl.empty();
	}

	showHistory(path: string | null): void {
		this.tab = ESourceTab.History;
		this.historyTab.setPath(path);
		this.render(this.plugin.controller.getSnapshot(), true);
	}

	showDeleted(): void {
		this.tab = ESourceTab.Deleted;
		this.render(this.plugin.controller.getSnapshot(), true);
	}

	showChanges(): void {
		this.activateTab(ESourceTab.Changes);
	}

	private renderActiveTab(
		panel: HTMLElement,
		tools: HTMLElement,
		overlay: HTMLElement,
	): void {
		if (this.tab === ESourceTab.History) this.historyTab.render(panel, tools);
		else if (this.tab === ESourceTab.Deleted)
			this.trashTab.render(panel, tools, overlay);
		else this.timelineTab.render(panel, tools);
	}

	/** Lists that failed for want of a connection, whichever tab shows now. */
	private clearOfflineLists(): boolean {
		return [this.historyTab, this.trashTab, this.timelineTab]
			.map((tab) => tab.clearOffline())
			.some(Boolean);
	}

	refreshHistory(): void {
		this.trashTab.clear();
		this.timelineTab.clear();
		this.historyTab.clearVersions();
		this.render(this.plugin.controller.getSnapshot(), true);
	}

	refreshDisplaySettings(): void {
		this.changes.invalidate();
		this.render(this.plugin.controller.getSnapshot(), true);
	}

	private render(snapshot: SyncStatusSnapshot, force = false): void {
		if (!this.root) return;
		const root = this.root;
		if (this.tab !== ESourceTab.Changes) {
			if (!force) return;
			if (this.tab === ESourceTab.Timeline) this.timelineTab.captureState();
			this.changes.dispose();
			this.changes.invalidate();
			root.empty();
			const tools = this.renderTabBar(root);
			this.renderActiveTab(this.renderTabPanel(root), tools, root);
			return;
		}
		if (!force && !this.changes.needsRebuild(snapshot)) {
			this.changes.refreshInPlace(snapshot);
			return;
		}
		const scrollTop =
			root.querySelector<HTMLElement>(".mdsync-source-tab-panel")?.scrollTop ??
			0;
		root.empty();
		const tools = this.renderTabBar(root);
		const panel = this.renderTabPanel(root);
		this.changes.render(panel, snapshot, tools, root);
		// Emptying the pane clamped the scroll to nothing, so the lists mounted
		// against the top. Restoring it moves them without a scroll event.
		panel.scrollTop = scrollTop;
		this.changes.refreshLists();
	}

	private renderTabPanel(parent: HTMLElement): HTMLElement {
		const panel = parent.createDiv({ cls: "mdsync-source-tab-panel" });
		panel.id = SOURCE_TAB_PANEL_ID;
		panel.setAttr("role", "tabpanel");
		panel.setAttr("aria-labelledby", `mdsync-source-tab-${this.tab}`);
		return panel;
	}

	/** Returns the row's trailing slot, where the Changes tab puts its tools. */
	private renderTabBar(parent: HTMLElement): HTMLElement {
		const row = parent.createDiv({ cls: "mdsync-source-tabs-row" });
		if (Platform.isPhone) {
			const back = row.createEl("button", { cls: "mdsync-mobile-back" });
			back.type = "button";
			back.setAttr("aria-label", "Close source control");
			setIcon(back, "arrow-left");
			back.addEventListener("click", () => this.close());
		}
		const bar = row.createDiv({
			cls: "mdsync-settings-tabs mdsync-source-tabs",
		});
		bar.setAttr("role", "tablist");
		bar.setAttr("aria-label", "Source control views");
		const make = (tab: ESourceTab, label: string, icon: string): void => {
			const btn = bar.createEl("button", {
				cls: "mdsync-settings-tab-button",
			});
			btn.type = "button";
			btn.setAttr("role", "tab");
			btn.setAttr("aria-label", label);
			btn.setAttr("aria-selected", String(tab === this.tab));
			btn.setAttr("aria-controls", SOURCE_TAB_PANEL_ID);
			btn.setAttr("tabindex", tab === this.tab ? "0" : "-1");
			btn.id = `mdsync-source-tab-${tab}`;
			btn.setAttr("data-mdsync-tab", tab);
			const iconEl = btn.createSpan({ cls: "mdsync-source-tab-icon" });
			setIcon(iconEl, icon);
			btn.createSpan({ cls: "mdsync-source-tab-label", text: label });
			if (tab === this.tab) btn.addClass("is-active");
			btn.addEventListener("click", () => this.activateTab(tab));
			btn.addEventListener("keydown", (event: KeyboardEvent) => {
				const current = SOURCE_TABS.findIndex((item) => item.tab === tab);
				let next = current;
				if (event.key === "ArrowLeft") next = current - 1;
				else if (event.key === "ArrowRight") next = current + 1;
				else if (event.key === "Home") next = 0;
				else if (event.key === "End") next = SOURCE_TABS.length - 1;
				else return;
				event.preventDefault();
				const target =
					SOURCE_TABS[(next + SOURCE_TABS.length) % SOURCE_TABS.length];
				if (target) this.activateTab(target.tab, true);
			});
		};
		for (const { tab, label, icon } of SOURCE_TABS) make(tab, label, icon);
		return row.createDiv({ cls: "mdsync-source-tools" });
	}

	/** A sidebar's leaf stays: the drawer lists only the views it holds. */
	private close(): void {
		const { leftSplit, rightSplit } = this.app.workspace;
		const side = [leftSplit, rightSplit].find(
			(split) => split === this.leaf.getRoot(),
		);
		if (side) side.collapse();
		else this.leaf.detach();
	}

	private activateTab(tab: ESourceTab, restoreFocus = false): void {
		if (this.tab === tab) return;
		if (this.tab === ESourceTab.Timeline) this.timelineTab.captureState();
		this.changes.invalidate();
		this.tab = tab;
		if (tab === ESourceTab.History && !this.historyTab.hasPath) {
			const active = this.plugin.app.workspace.getActiveFile();
			if (active) this.historyTab.setPath(active.path);
		}
		this.render(this.plugin.controller.getSnapshot(), true);
		if (!restoreFocus) return;
		this.root
			?.querySelector<HTMLButtonElement>(`[data-mdsync-tab="${tab}"]`)
			?.focus();
	}
}
