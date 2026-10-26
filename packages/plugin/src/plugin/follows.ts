import type { Plugin } from "obsidian";

import { CursorFollow } from "@/ui";
import type { PluginHost } from "./host";

/** One for the plugin: the note header's menu and the share window both start following. */
export function registerFollows(plugin: Plugin & PluginHost): CursorFollow {
	const follows = new CursorFollow(plugin);
	plugin.register(() => follows.stop());
	return follows;
}
