import type { Plugin } from "obsidian";
import type { PluginHost } from "@/app/host";
import { CursorFollow } from "./cursor-follow";

/** One for the plugin: the note header's menu and the share window both start following. */
export function registerFollows(plugin: Plugin & PluginHost): CursorFollow {
	const follows = new CursorFollow(plugin);
	plugin.register(() => follows.stop());
	return follows;
}
