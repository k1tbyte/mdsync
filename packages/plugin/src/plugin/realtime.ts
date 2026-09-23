import { CHANNEL_DOC, EFrame, type ServerFrame } from "@obsync/protocol";
import { debounce } from "obsidian";

import { HubConnection, VAULT_SLOT } from "@/hub/connection";
import { DevicePresence } from "@/hub/presence";
import type { ObsyncSettings } from "@/settings/model";
import type { SyncController } from "@/sync/controller";

const REALTIME_SYNC_DEBOUNCE_MS = 2_000;

export interface Realtime {
	readonly hub: HubConnection;
	readonly presence: DevicePresence;
	dispose(): void;
}

/** The vault's hub connection, its device list, and a pull when another device pushed. */
export function createRealtime(
	controller: SyncController,
	settings: () => ObsyncSettings,
): Realtime {
	const hub = new HubConnection({
		settings,
		deviceId: () => controller.currentDevice().id,
	});
	const presence = new DevicePresence(hub, () => controller.currentDevice());
	// resetTimer is off: a steady stream of signals must still let a pull through.
	const pull = debounce(
		() => {
			void controller.refreshAndAutoPull();
		},
		REALTIME_SYNC_DEBOUNCE_MS,
		false,
	);
	hub.listen(presence);
	hub.listen({
		onFrame: (frame) => {
			if (isVaultSignal(frame)) pull();
		},
		onConnectionChange: (connected) => {
			if (!connected) pull.cancel();
		},
	});
	return {
		hub,
		presence,
		dispose() {
			pull.cancel();
			hub.dispose();
		},
	};
}

function isVaultSignal(frame: ServerFrame): boolean {
	return (
		frame.type === EFrame.Signal &&
		frame.slot === VAULT_SLOT &&
		frame.doc === CHANNEL_DOC
	);
}
