import { debounce } from "obsidian";

import { HubConnection } from "@/hub";
import type { LiveSessions } from "@/live";
import { People, watchHere } from "@/presence";
import type { LiveNotes } from "@/sync/live-notes";
import { type Space, VAULT_SPACE } from "@/sync/space";

import { createLive, type LiveHost } from "./live";
import { createSpaceAccess } from "./space-access";

const REALTIME_SYNC_DEBOUNCE_MS = 2_000;
/** How long an unload waits for the rooms' last edits before closing the sockets. */
const ROOMS_CLOSE_MS = 2_000;

export interface Realtime {
	readonly hub: HubConnection;
	readonly people: People;
	readonly live: LiveSessions;
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
		spaces: () => host.spaces.partition(),
		access,
	});
	const here = watchHere(
		host.app,
		(now) => people.setHere(now),
		() => settings().showOpenNote,
	);
	const pendingSpaces = new Set<string>();
	// A steady stream of signals must still let a pull through.
	const pull = debounce(
		() => {
			const targets = new Set(pendingSpaces);
			pendingSpaces.clear();
			void controller.refreshAndAutoPull(targets);
		},
		REALTIME_SYNC_DEBOUNCE_MS,
		false,
	);
	// Kept across the vault socket's drops: the signal may have come on a share's.
	const queuePull = (space = VAULT_SPACE.id): void => {
		pendingSpaces.add(space);
		pull();
	};
	const unlisten = hub.listen({ onSignal: queuePull, onRevoked: queuePull });
	const live = createLive(host, hub, access, (space, person) =>
		people.nameOf(space, person),
	);
	people.refresh();
	return {
		hub,
		people,
		live: live.sessions,
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
			unlisten();
			pull.cancel();
			// Closed first, the socket would drop the rooms' last edits and their Unsub.
			const closed = live.dispose();
			const late = new Promise((resolve) =>
				window.setTimeout(resolve, ROOMS_CLOSE_MS),
			);
			void Promise.race([closed, late]).then(() => hub.dispose());
		},
	};
}
