import { type Plugin, TFile, TFolder } from "obsidian";
import { reportWarning } from "@/core/shared";
import { addLinkMenuItems } from "@/features/links";
import { addHistoryMenuItems } from "@/features/source-control";
import { addShareMenuItem } from "@/features/spaces";
import type { StatePersister } from "@/features/sync";
import { addIgnoreMenuItem, addPushMenuItem } from "@/features/sync";
import type { PluginHost } from "./host";

/** The menus' order is the slices' order here. */
export function registerWorkspaceMenus(plugin: Plugin & PluginHost): void {
	plugin.registerEvent(
		plugin.app.workspace.on("file-menu", (menu, file) => {
			const folder = file instanceof TFolder;
			addIgnoreMenuItem(menu, plugin, file.path, folder, "MDSync: ");
			addPushMenuItem(menu, plugin, file.path, folder);
			addLinkMenuItems(menu, plugin, file);
			if (folder && !file.isRoot()) addShareMenuItem(menu, plugin, file.path);
			addHistoryMenuItems(
				menu,
				plugin,
				file instanceof TFile ? file.path : null,
			);
		}),
	);
	plugin.registerEvent(
		plugin.app.workspace.on("editor-menu", (menu, _editor, view) => {
			const path = view.file?.path ?? null;
			if (path) addPushMenuItem(menu, plugin, path, false);
			addHistoryMenuItems(menu, plugin, path);
		}),
	);
}

export function registerHashCarry(
	plugin: Plugin,
	statePersister: StatePersister,
): void {
	plugin.registerEvent(
		plugin.app.vault.on("rename", (file, oldPath) =>
			statePersister.carry({
				from: oldPath,
				to: file.path,
				folder: file instanceof TFolder,
			}),
		),
	);
}

export function registerStatePersistenceFlush(
	plugin: Plugin & PluginHost,
	statePersister: StatePersister,
): void {
	const flush = (): void => {
		statePersister
			.flush()
			.catch((err) => reportWarning("Could not save the sync state.", err));
	};

	plugin.registerDomEvent(document, "visibilitychange", () => {
		if (document.visibilityState === "hidden") flush();
	});
	plugin.registerDomEvent(window, "beforeunload", flush);
}
