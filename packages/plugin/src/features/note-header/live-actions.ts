import { notifyInfo, reportError } from "@/core/ui";
import type { Rotation } from "@/features/live";
import type { NoteHeaderHost } from "./host";

const REBUILT: Record<Rotation, string> = {
	moved: "Live note rebuilt from its text.",
	refused: "The note changed meanwhile. Try again.",
	busy: "Still sending edits. Try again in a moment.",
};

export function toggleAuthors(plugin: NoteHeaderHost): void {
	const shown = !plugin.settings.showLiveAuthors;
	plugin.settings.showLiveAuthors = shown;
	plugin.realtime.live.repaintAuthors();
	void plugin.saveSettings();
	notifyInfo(
		shown
			? "Text others typed in live notes is tinted by author."
			: "Authors hidden.",
	);
}

export function rebuildLiveNote(plugin: NoteHeaderHost, path: string): void {
	void plugin.realtime.live
		.rotate(path)
		.then((outcome) => notifyInfo(REBUILT[outcome]))
		.catch(reportError);
}
