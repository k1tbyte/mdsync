import type { Plugin } from "obsidian";
import { notifyAction, notifyInfo } from "@/core/ui";
import { markTheirs } from "@/features/presence";
import { refreshHistoryAfterPush } from "@/features/source-control";
import {
	createAccessEnded,
	createShareRegistration,
	createSpaceGone,
} from "@/features/spaces";
import type { BootstrapPluginRuntimeOptions } from "./bootstrap";
import type { PluginHost } from "./host";
import { createStorageRefused } from "./storage-refused";

export type RuntimeHooks = Omit<
	BootstrapPluginRuntimeOptions,
	"app" | "settings" | "deviceKey" | "links"
>;

/** What the sync runtime tells the rest of the plugin; read at call time, as the host is complete only after bootstrap. */
export function createRuntimeHooks(plugin: Plugin & PluginHost): RuntimeHooks {
	const registerShare = createShareRegistration(plugin);
	return {
		onPushComplete: (space) => {
			plugin.realtime.hub.signal(space.id);
			refreshHistoryAfterPush(plugin);
		},
		onSpaceRefreshed: (space) => void registerShare(space),
		onShareRefused: createAccessEnded(plugin),
		onStorageRefused: createStorageRefused(plugin),
		onSpaceGone: createSpaceGone(plugin),
		onUnindexed: (count) =>
			notifyInfo(
				`Obsidian has not loaded ${count} files that are on disk. MDSync syncs them; restart Obsidian to see them.`,
			),
		onDeletionsHeld: (space, paths) =>
			notifyAction(
				`Auto-push held back ${paths.length} deleted files${space.root ? ` in "${space.root}"` : ""}. Review them before they sync.`,
				"Review",
				() => void plugin.openChanges(),
			),
		onTheirsPulled: (space, paths) =>
			markTheirs(plugin, plugin.unseen, space, paths),
		onNoStorage: () =>
			notifyAction("Set up storage to sync.", "Set up", () =>
				plugin.openSetup(),
			),
		persistSettings: () => plugin.saveSettings(),
		// The first refresh can precede the realtime coordinator.
		liveNotes: (space) => plugin.realtime?.liveNotes(space),
	};
}
