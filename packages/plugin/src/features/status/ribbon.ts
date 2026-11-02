import type { App, Plugin } from "obsidian";

import { SOURCE_CONTROL_VIEW_TYPE } from "@/core/constants";
import type { HubConnection } from "@/features/relay";
import { openSourceControlView } from "@/features/source-control";
import type { SyncController, SyncStatusSnapshot } from "@/features/sync";
import type { StatusHost } from "./host";
import { syncHeadline } from "./status-menu";

export function registerRibbon(
	plugin: Plugin & StatusHost,
	controller: SyncController,
	hub: Pick<HubConnection, "isConnected" | "listen">,
): void {
	// A holder, not `plugin`: other plugins keep this element in event maps after unload, retaining the
	// click closure's captures.
	const host: { app: App | null } = { app: plugin.app };
	plugin.register(() => {
		host.app = null;
	});
	const icon = plugin.addRibbonIcon("refresh-cw", "MDSync", () => {
		if (host.app)
			void openSourceControlView(host.app, SOURCE_CONTROL_VIEW_TYPE);
	});
	icon.addClass("mdsync-ribbon-icon");

	const apply = (snapshot: SyncStatusSnapshot): void => {
		const pending = snapshot.pendingLocal + snapshot.pendingRemote;
		const hasConflict = snapshot.conflicts > 0;
		icon.toggleClass("is-pending", pending > 0 || hasConflict);
		icon.toggleClass("is-conflict", hasConflict);
		// The status bar's words, so the two never disagree.
		icon.setAttr("aria-label", `MDSync: ${syncHeadline(plugin, snapshot)}`);
	};

	// A CSS class, not an element: `setIcon` removes the first child and appends a new one, so an element of ours
	// beside the icon makes a second call throw it away and leave two icons behind.
	const applyRelay = (connected: boolean): void => {
		icon.toggleClass("is-relay-connected", connected);
	};

	apply(controller.getSnapshot());
	applyRelay(hub.isConnected());

	plugin.register(controller.subscribe(apply));
	const unlisten = hub.listen({ onConnectionChange: applyRelay });
	plugin.register(() => {
		unlisten();
	});
}
