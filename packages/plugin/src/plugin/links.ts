import type { Plugin } from "obsidian";

import { reportWarning } from "@/shared";

import type { PluginHost } from "./host";

/** A renamed note keeps its links; a deleted one lets go of them, so a new note at its path starts clean. */
export function registerLinkPaths(plugin: Plugin & PluginHost): void {
	const { vault } = plugin.app;
	plugin.registerEvent(
		vault.on("rename", (file, oldPath) => {
			plugin.sharedLinks
				.move(oldPath, file.path)
				.catch((err) => reportWarning("Could not save the moved link.", err));
		}),
	);
	plugin.registerEvent(
		vault.on("delete", (file) => {
			plugin.sharedLinks
				.detach(file.path)
				.catch((err) =>
					reportWarning("Could not save the detached link.", err),
				);
		}),
	);
}
