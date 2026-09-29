import { debounce } from "obsidian";

import { HubConnection } from "@/hub/connection";
import type { RelayStatus } from "@/hub/status";
import type { LiveSessions } from "@/live/sessions";
import { watchHere } from "@/presence/here";
import { People } from "@/presence/people";
import type { LiveNotes } from "@/sync/live-notes";
import type { Space } from "@/sync/space";

import { createLive, type LiveHost } from "./live";
import { createSpaceAccess } from "./space-access";

const REALTIME_SYNC_DEBOUNCE_MS = 2_000;

export interface Realtime {
	readonly hub: HubConnection;
	readonly people: People;
	readonly live: LiveSessions;
	/** What the relay does for a space: the one source for every place that shows it. */
	statusOf(spaceId: string): RelayStatus;
	/** What the file sync asks of live editing, per space. */
	liveNotes(space: Space): LiveNotes;
	/** After any settings write: sockets, rooms and channels follow the records and credentials. */
	refresh(): void;
	dispose(): void;
}

/** The hub sockets, who is where, live notes, and a pull when another device pushed into any space. */
export function createRealtime(host: LiveHost): Realtime {
	const { controller, settings } = host;
	const hub = new HubConnection({
		settings,
		deviceId: () => controller.currentDevice().id,
	});
	const access = createSpaceAccess(host);
	const people = new People({
		hub,
		spaces: () => host.partition(),
		access,
	});
	const here = watchHere(
		host.app,
		(now) => people.setHere(now),
		() => settings().showOpenNote,
	);
	// resetTimer is off: a steady stream of signals must still let a pull through.
	const pull = debounce(
		() => {
			void controller.refreshAndAutoPull();
		},
		REALTIME_SYNC_DEBOUNCE_MS,
		false,
	);
	// Kept across the vault socket's drops: the signal may have come on a share's.
	hub.listen({ onSignal: pull });
	const live = createLive(host, hub, access);
	people.refresh();
	return {
		hub,
		people,
		live: live.sessions,
		statusOf: (spaceId) => hub.statusOf(spaceId),
		liveNotes: live.notes,
		refresh() {
			hub.restartIfChanged();
			void live.sessions.refresh();
			people.refresh();
			here.refresh();
		},
		dispose() {
			here.stop();
			people.dispose();
			live.dispose();
			pull.cancel();
			hub.dispose();
		},
	};
}
