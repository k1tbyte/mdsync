import { Platform, type Plugin } from "obsidian";
import { DIFF_VIEW_TYPE, SOURCE_CONTROL_VIEW_TYPE } from "@/constants";
import type { PluginHost } from "@/plugin/host";
import { MdsyncSettingTab } from "@/settings/tab";
import type { SyncController } from "@/sync/controller";
import {
	DiffView,
	type IndicatorHandle,
	keepInRightSidebar,
	registerFileContextIndicators,
	registerFileExplorerIndicators,
	registerNoteLinkActions,
	registerNotePresence,
	registerRibbon,
	registerStatusBar,
	SourceControlView,
} from "@/ui";

interface RegisteredPluginUi {
	settingsTab: MdsyncSettingTab;
	fileIndicators: IndicatorHandle;
	openNoteMenu: (checking: boolean) => boolean;
	/** Repaints the status bar item; a no-op when it is off. */
	refreshStatusBar: () => void;
}

export function registerPluginUi(
	plugin: Plugin & PluginHost,
	controller: SyncController,
): RegisteredPluginUi {
	const settingsTab = new MdsyncSettingTab(plugin.app, plugin);
	plugin.addSettingTab(settingsTab);

	plugin.registerView(
		SOURCE_CONTROL_VIEW_TYPE,
		(leaf) => new SourceControlView(leaf, plugin),
	);
	plugin.registerView(DIFF_VIEW_TYPE, (leaf) => new DiffView(leaf, plugin));
	if (Platform.isMobile) {
		// After onload: re-enabled, Obsidian gives back our emptied leaves only then, and one kept sooner doubles.
		plugin.app.workspace.onLayoutReady(() =>
			window.setTimeout(() => keepInRightSidebar(plugin.app)),
		);
	}

	const refreshStatusBar = plugin.settings.showStatusBar
		? registerStatusBar(plugin)
		: () => {};
	const openNoteMenu = registerNotePresence(plugin);
	registerNoteLinkActions(plugin);
	if (plugin.settings.showRibbonIcon) {
		registerRibbon(plugin, controller, plugin.realtime.hub);
	}
	const explorerIndicators = registerFileExplorerIndicators(plugin, controller);
	const contextIndicators = registerFileContextIndicators(plugin);
	const fileIndicators: IndicatorHandle = {
		refresh(enabled) {
			explorerIndicators.refresh(enabled);
			contextIndicators.refresh(enabled);
		},
	};
	fileIndicators.refresh(plugin.settings.showFileExplorerIndicators);

	return { settingsTab, fileIndicators, openNoteMenu, refreshStatusBar };
}

export function refreshOpenHistoryViewsAfterPush(
	plugin: Plugin & PluginHost,
): void {
	if (!plugin.settings.historyAutoRefresh) return;
	for (const leaf of plugin.app.workspace.getLeavesOfType(
		SOURCE_CONTROL_VIEW_TYPE,
	)) {
		if (leaf.view instanceof SourceControlView) {
			leaf.view.refreshHistory();
		}
	}
}

export function refreshOpenSourceControlViews(
	plugin: Plugin & PluginHost,
): void {
	for (const leaf of plugin.app.workspace.getLeavesOfType(
		SOURCE_CONTROL_VIEW_TYPE,
	)) {
		if (leaf.view instanceof SourceControlView) {
			leaf.view.refreshDisplaySettings();
		}
	}
}
