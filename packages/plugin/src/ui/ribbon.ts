import type { App, Plugin } from "obsidian";

import { SOURCE_CONTROL_VIEW_TYPE } from "@/constants";
import type { HubConnection } from "@/hub";
import type { SyncController, SyncStatusSnapshot } from "@/sync/controller";
import { openSourceControlView } from "./source-control-view";

export function registerRibbon(
	plugin: Plugin,
	controller: SyncController,
	hub: Pick<HubConnection, "isConnected" | "listen">,
): void {
	// A holder, not `plugin`: other plugins keep this element in event maps after unload, retaining the
	// click closure's captures.
	const host: { app: App | null } = { app: plugin.app };
	plugin.register(() => {
		host.app = null;
	});
	const icon = plugin.addRibbonIcon("refresh-cw", "Obsync", () => {
		if (host.app)
			void openSourceControlView(host.app, SOURCE_CONTROL_VIEW_TYPE);
	});
	icon.addClass("obsync-ribbon-icon");

	const apply = (snapshot: SyncStatusSnapshot): void => {
		const pending = snapshot.pendingLocal + snapshot.pendingRemote;
		const hasConflict = snapshot.conflicts > 0;
		icon.toggleClass("is-pending", pending > 0 || hasConflict);
		icon.toggleClass("is-conflict", hasConflict);
		icon.setAttr("aria-label", buildLabel(snapshot));
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

function buildLabel(snapshot: SyncStatusSnapshot): string {
	if (snapshot.conflicts > 0)
		return `Obsync — ${snapshot.conflicts} conflict(s)`;
	const pending = snapshot.pendingLocal + snapshot.pendingRemote;
	if (pending === 0) return "Obsync — no changes";
	return `Obsync — ${snapshot.pendingLocal} to push, ${snapshot.pendingRemote} to pull`;
}
