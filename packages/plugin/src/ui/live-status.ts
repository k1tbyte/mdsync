import { type FileView, MarkdownView, type TFile } from "obsidian";

import { isLiveDocument } from "@/live/doc-types";
import type { PluginHost } from "@/plugin/host";
import { type Space, spaceOf } from "@/sync/space";

export type LiveState = "live" | "joining" | "offline" | "cold";

export interface LiveStatus {
	state: LiveState;
	label: string;
}

/** Whether the file is live here, and why not; null where no relay carries its space. */
export function liveStatusOf(
	plugin: PluginHost,
	view: FileView,
	file: TFile,
): LiveStatus | null {
	const { hub, people, live } = plugin.realtime;
	const space = spaceOf(plugin.spaces.partition(), file.path);
	if (space.paused) {
		return { state: "cold", label: "Paused on this device: nothing syncs" };
	}
	if (!hub.carries(space.id)) return null;
	if (!people.connected(space.id)) {
		return {
			state: "offline",
			label: "Relay unreachable: changes sync on the schedule",
		};
	}
	if (live.roomOf(file.path)) {
		return { state: "live", label: "Live: edits reach everyone as you type" };
	}
	if (live.joining(file.path)) {
		return { state: "joining", label: "Joining live editing…" };
	}
	return { state: "cold", label: coldReason(plugin, view, file, space) };
}

function coldReason(
	plugin: PluginHost,
	view: FileView,
	file: TFile,
	space: Space,
): string {
	if (!plugin.settings.liveEditing) {
		return "Live editing is off: changes sync on the schedule";
	}
	if (space.readOnly) return "Read-only: changes arrive as they sync";
	if (!(view instanceof MarkdownView) || !isLiveDocument(plugin.app, file)) {
		return "Not a live note: changes sync on the schedule";
	}
	if (view.getMode() !== "source") {
		return "Live in the editor, not in reading view";
	}
	return "Waiting for the key: sync once to go live";
}
