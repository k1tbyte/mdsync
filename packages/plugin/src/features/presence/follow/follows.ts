import type { Plugin } from "obsidian";
import type { PresenceHost } from "../host";
import { CursorFollow } from "./cursor-follow";

/** One for the plugin: the note header's menu and the share window both start following. */
export function registerFollows(plugin: Plugin & PresenceHost): CursorFollow {
	const follows = new CursorFollow(plugin);
	plugin.register(() => follows.stop());
	return follows;
}
