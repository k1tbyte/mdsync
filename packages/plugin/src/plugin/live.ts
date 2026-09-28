import type { App, EventRef } from "obsidian";

import type { HubConnection } from "@/hub/connection";
import { AgreedTexts } from "@/live/agreed-texts";
import { LiveColdSync } from "@/live/cold-sync";
import { LiveSessions } from "@/live/sessions";
import type { LiveSpace } from "@/live/space";
import { personColors } from "@/shared/colors";
import type { LiveNotes } from "@/sync/live-notes";
import { type Space, spaceOf } from "@/sync/space";

import type { SpaceAccess, SpaceAccessHost } from "./space-access";

export interface LiveHost extends SpaceAccessHost {
	app: App;
	/** The spaces as the records have them now, ahead of the next refresh. */
	partition(): readonly Space[];
}

/** Live editing wired to the workspace: which notes are open decides which rooms are joined. */
export function createLive(
	host: LiveHost,
	hub: HubConnection,
	access: (space: Space) => Promise<SpaceAccess | null>,
): {
	sessions: LiveSessions;
	notes(space: Space): LiveNotes;
	dispose(): void;
} {
	const { workspace, vault } = host.app;
	const agreed = new AgreedTexts(vault.adapter, vault.configDir);
	void agreed.prune();
	const liveSpace = createLiveSpaces(host, access);
	const sessions = new LiveSessions({
		app: host.app,
		hub,
		liveSpace: (path) => liveSpace(spaceOf(host.partition(), path)),
		agreed,
		baseText: async (path) =>
			(await host.controller.fileDiffs.loadBaselineForPath(path))?.text ?? null,
	});
	const refresh = () => void sessions.refresh();
	const refs: EventRef[] = [
		workspace.on("layout-change", refresh),
		workspace.on("active-leaf-change", refresh),
		workspace.on("file-open", refresh),
	];
	const unlisten = hub.listen({
		// The first connection may be what brings the key within reach.
		onConnectionChange: (connected) => connected && refresh(),
	});
	workspace.onLayoutReady(refresh);
	return {
		sessions,
		// Bound to the sync session's own space, whose partition is fixed per refresh.
		notes: (space) =>
			new LiveColdSync({
				rooms: sessions,
				agreed,
				space: space.id,
				live: () => liveSpace(space),
			}),
		dispose() {
			for (const ref of refs) workspace.offref(ref);
			unlisten();
			sessions.dispose();
		},
	};
}

/** Live editing on top of the space's access. Paused and read-only shares stay cold: the hub refuses a read-only person's writes. */
function createLiveSpaces(
	host: LiveHost,
	access: (space: Space) => Promise<SpaceAccess | null>,
): (space: Space) => Promise<LiveSpace | null> {
	return async (space) => {
		if (!host.settings().liveEditing || space.paused || space.readOnly) {
			return null;
		}
		const at = await access(space);
		if (!at) return null;
		const { keys, person, key, name } = at;
		// Coloured by key, so a cursor matches the tint of that person's text.
		const user = { key, name, ...personColors(key) };
		return { id: space.id, root: space.root, keys, person, user };
	};
}
