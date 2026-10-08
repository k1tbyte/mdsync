import type { Plugin } from "obsidian";

import { reportWarning } from "@/shared";

import type { PluginHost } from "./host";

/** A renamed note keeps its links: they follow it to the new path. */
export function registerLinkRenames(plugin: Plugin & PluginHost): void {
	plugin.registerEvent(
		plugin.app.vault.on("rename", (file, oldPath) => {
			plugin.sharedLinks
				.move(oldPath, file.path)
				.catch((err) => reportWarning("Could not save the moved link.", err));
		}),
	);
}
