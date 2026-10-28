import type { App, Menu, WorkspaceLeaf } from "obsidian";
import { SOURCE_CONTROL_VIEW_TYPE } from "@/core/constants";
import type { SourceControlHost } from "./host";
import { SourceControlView } from "./view";

export function openSourceControlHistory(
	plugin: SourceControlHost,
	path?: string,
): Promise<void> {
	return openSourceControlOn(plugin, (view) => view.showHistory(path ?? null));
}

export function openSourceControlDeleted(
	plugin: SourceControlHost,
): Promise<void> {
	return openSourceControlOn(plugin, (view) => view.showDeleted());
}

/** The Timeline filtered to the local day starting at `day`. */
export function openSourceControlTimeline(
	plugin: SourceControlHost,
	day?: number,
): Promise<void> {
	return openSourceControlOn(plugin, (view) => view.showTimeline(day));
}

/** An open view keeps its tab; conflicts are only on Changes. */
export function openSourceControlChanges(
	plugin: SourceControlHost,
): Promise<void> {
	return openSourceControlOn(plugin, (view) => view.showChanges());
}

async function openSourceControlOn(
	plugin: SourceControlHost,
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

/** History is otherwise only in the side panel and a deleted file has no menu, so both ride on any file menu. */
export function addHistoryMenuItems(
	menu: Menu,
	plugin: SourceControlHost,
	path: string | null,
): void {
	if (!plugin.settings.fileHistoryEnabled) return;
	if (path) {
		menu.addItem((item) =>
			item
				.setTitle("MDSync: File history")
				.setIcon("history")
				.onClick(() => void openSourceControlHistory(plugin, path)),
		);
	}
	menu.addItem((item) =>
		item
			.setTitle("MDSync: Restore deleted files")
			.setIcon("trash-2")
			.onClick(() => void openSourceControlDeleted(plugin)),
	);
}

export function refreshHistoryAfterPush(plugin: SourceControlHost): void {
	if (!plugin.settings.historyAutoRefresh) return;
	for (const view of openViews(plugin.app)) view.refreshHistory();
}

/** `history` also drops loaded history: a new horizon changes every date it computed. */
export function refreshSourceControlViews(app: App, history = false): void {
	for (const view of openViews(app)) {
		if (history) view.refreshHistory();
		else view.refreshDisplaySettings();
	}
}

function openViews(app: App): SourceControlView[] {
	return app.workspace
		.getLeavesOfType(SOURCE_CONTROL_VIEW_TYPE)
		.flatMap((leaf) =>
			leaf.view instanceof SourceControlView ? [leaf.view] : [],
		);
}
