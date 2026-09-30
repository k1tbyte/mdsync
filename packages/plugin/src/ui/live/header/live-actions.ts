import type { Rotation } from "@/live/session/session-deps";
import type { PluginHost } from "@/plugin/host";
import { notifyInfo, reportError } from "@/ui/common";

const REBUILT: Record<Rotation, string> = {
	moved: "Live note rebuilt from its text.",
	refused: "The note changed meanwhile. Try again.",
	busy: "Still sending edits. Try again in a moment.",
};

export function toggleAuthors(plugin: PluginHost): void {
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

export function rebuildLiveNote(plugin: PluginHost, path: string): void {
	void plugin.realtime.live
		.rotate(path)
		.then((outcome) => notifyInfo(REBUILT[outcome]))
		.catch(reportError);
}
