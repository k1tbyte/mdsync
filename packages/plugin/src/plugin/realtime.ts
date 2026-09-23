import { CHANNEL_DOC, EFrame, type ServerFrame } from "@obsync/protocol";
import { debounce } from "obsidian";

import { HubConnection, VAULT_SLOT } from "@/hub/connection";
import { DevicePresence } from "@/hub/presence";
import type { LiveSessions } from "@/live/sessions";
import type { LiveNotes } from "@/sync/live-notes";

import { createLive, type LiveHost } from "./live";

const REALTIME_SYNC_DEBOUNCE_MS = 2_000;

export interface Realtime {
	readonly hub: HubConnection;
	readonly presence: DevicePresence;
	readonly live: LiveSessions;
	/** What the file sync asks of live editing. */
	readonly liveNotes: LiveNotes;
	dispose(): void;
}

/** The vault's hub connection, its device list, live notes, and a pull when another device pushed. */
export function createRealtime(host: LiveHost): Realtime {
	const { controller, settings } = host;
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
	const live = createLive(host, hub);
	return {
		hub,
		presence,
		live: live.sessions,
		liveNotes: live.notes,
		dispose() {
			live.dispose();
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
