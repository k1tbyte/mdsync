import { debounce } from "obsidian";

import { HubConnection } from "@/hub/connection";
import { DevicePresence } from "@/hub/presence";
import type { LiveSessions } from "@/live/sessions";
import type { LiveNotes } from "@/sync/live-notes";
import { type Space, VAULT_SPACE } from "@/sync/space";

import { createLive, type LiveHost } from "./live";

const REALTIME_SYNC_DEBOUNCE_MS = 2_000;

export interface Realtime {
	readonly hub: HubConnection;
	readonly presence: DevicePresence;
	readonly live: LiveSessions;
	/** What the file sync asks of live editing, per space. */
	liveNotes(space: Space): LiveNotes;
	dispose(): void;
}

/** The hub sockets, the vault's device list, live notes, and a pull when another device pushed into any space. */
export function createRealtime(host: LiveHost): Realtime {
	const { controller, settings } = host;
	const hub = new HubConnection({
		settings,
		deviceId: () => controller.currentDevice().id,
	});
	const vault = hub.space(VAULT_SPACE.id);
	const presence = new DevicePresence(vault, () => controller.currentDevice());
	// resetTimer is off: a steady stream of signals must still let a pull through.
	const pull = debounce(
		() => {
			void controller.refreshAndAutoPull();
		},
		REALTIME_SYNC_DEBOUNCE_MS,
		false,
	);
	vault.listen(presence);
	// Kept across the vault socket's drops: the signal may have come on a share's.
	hub.listen({ onSignal: pull });
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
