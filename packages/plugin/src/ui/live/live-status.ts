import { type FileView, MarkdownView, type TFile } from "obsidian";

import { isLinkState } from "@/hub/status";
import { docKindOf, LIVE_VIEWS, liveKindOf } from "@/live/doc-types";
import type { ColdCause } from "@/live/sessions";
import type { PluginHost } from "@/plugin/host";
import { type Space, spaceOf } from "@/sync/space";

import { RELAY_TEXT, UNREADABLE_TEXT } from "./relay-text";

export type LiveState = "live" | "joining" | "offline" | "cold";

export const STATE_ICONS: Record<LiveState, string> = {
	live: "radio",
	joining: "loader",
	offline: "wifi-off",
	cold: "circle-dashed",
};

const READ_ONLY = "Read-only: changes arrive as they sync";

const COLD_CAUSES: Record<ColdCause, string> = {
	"too-large": "Too large to edit live: changes sync on the schedule",
	"too-many": "Too many notes open live: this one syncs on the schedule",
	"read-only": READ_ONLY,
	"moved-away": "Its live room moved away: changes sync on the schedule",
};

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
	const { people, live, statusOf } = plugin.realtime;
	const space = spaceOf(plugin.spaces.partition(), file.path);
	const relay = statusOf(space.id);
	if (!isLinkState(relay)) {
		return relay === "paused"
			? { state: "cold", label: RELAY_TEXT.paused }
			: null;
	}
	if (relay !== "connected") {
		const state = relay === "connecting" ? "joining" : "offline";
		return { state, label: RELAY_TEXT[relay] };
	}
	if (people.unreadable(space.id)) {
		return { state: "offline", label: UNREADABLE_TEXT };
	}
	if (live.roomOf(file.path)) {
		return { state: "live", label: "Live: edits reach everyone as you type" };
	}
	if (live.joining(file.path)) {
		return live.unanswered(file.path)
			? {
					state: "offline",
					label: "The live room is not answering: reopen the note to retry",
				}
			: { state: "joining", label: "Joining live editing…" };
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
	if (space.readOnly) return READ_ONLY;
	const cause = plugin.realtime.live.coldCause(file.path);
	if (cause) return COLD_CAUSES[cause];
	const kind = docKindOf(plugin.app, file);
	if (!kind || view.getViewType() !== LIVE_VIEWS[kind]) {
		return "Not a live note: changes sync on the schedule";
	}
	if (!liveKindOf(plugin.app, file)) return COLD_CAUSES["too-large"];
	if (view instanceof MarkdownView && view.getMode() !== "source") {
		return "Live in the editor, not in reading view";
	}
	return "Waiting for the key: sync once to go live";
}
