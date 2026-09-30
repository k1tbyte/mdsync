import { type FileView, MarkdownView, type TFile } from "obsidian";

import { isLinkState } from "@/hub/status";
import { type ColdCause, docKindOf, LIVE_VIEWS, liveKindOf } from "@/live";
import type { PluginHost } from "@/plugin/host";
import type { Space } from "@/sync/space";
import { RELAY_TEXT, UNREADABLE_TEXT } from "@/ui/common";
import { LINK_LIVE_STATE, type LiveState } from "@/ui/live/live-state";

const ARRIVES_ON_SYNC = "Changes arrive as they sync";

const COLD_CAUSES: Record<ColdCause, string> = {
	"too-large": "Too large to edit live: changes sync on the schedule",
	"too-many": "Too many notes open live: this one syncs on the schedule",
	"read-only": ARRIVES_ON_SYNC,
	"moved-away": "Live editing moved elsewhere: changes sync on the schedule",
	empty: "Nobody is editing it live yet: reopen it to follow them",
	diverged: "This copy differs from the live one: changes sync on the schedule",
};

export interface LiveStatus {
	state: LiveState;
	label: string;
}

/** Null where no relay carries `space`, the file's. */
export function liveStatusOf(
	plugin: PluginHost,
	view: FileView,
	file: TFile,
	space: Space,
): LiveStatus | null {
	const { people, live, hub } = plugin.realtime;
	const relay = hub.statusOf(space.id);
	if (!isLinkState(relay)) {
		return relay === "paused"
			? { state: "cold", label: RELAY_TEXT.paused }
			: null;
	}
	if (relay !== "connected") {
		return { state: LINK_LIVE_STATE[relay], label: RELAY_TEXT[relay] };
	}
	const note = live.noteState(file.path);
	if (note === "live") {
		if (people.unreadable(space.id)) {
			return { state: "warning", label: UNREADABLE_TEXT };
		}
		const label = space.readOnly
			? "Live: edits arrive as others type"
			: "Live: edits reach everyone as you type";
		return { state: "live", label };
	}
	if (note === "joining") {
		return { state: "joining", label: "Joining live editing…" };
	}
	if (note === "unanswered") {
		return {
			state: "offline",
			label: "Live editing is not answering: reopen the note to retry",
		};
	}
	return { state: "cold", label: coldReason(plugin, view, file, space, note) };
}

function coldReason(
	plugin: PluginHost,
	view: FileView,
	file: TFile,
	space: Space,
	cause: ColdCause | null,
): string {
	if (!plugin.settings.liveEditing) {
		return "Live editing is off: changes sync on the schedule";
	}
	if (cause) return COLD_CAUSES[cause];
	if (space.readOnly) return ARRIVES_ON_SYNC;
	const kind = docKindOf(plugin.app, file);
	if (!kind || view.getViewType() !== LIVE_VIEWS[kind]) {
		return "Not a live note: changes sync on the schedule";
	}
	if (!liveKindOf(plugin.app, file)) return COLD_CAUSES["too-large"];
	if (view instanceof MarkdownView && view.getMode() !== "source") {
		return "Live in the editor, not in reading view";
	}
	return "Not ready yet: sync once to go live";
}
