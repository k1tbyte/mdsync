import { OWNER } from "@obsync/protocol";
import type { App, EventRef } from "obsidian";

import type { PassphraseManager } from "@/core";
import { deriveLiveKeys, type LiveKeys } from "@/crypto/live-keys";
import type { HubConnection } from "@/hub/connection";
import { AgreedTexts } from "@/live/agreed-texts";
import { authorColors } from "@/live/authors";
import { LiveColdSync } from "@/live/cold-sync";
import { LiveSessions } from "@/live/sessions";
import type { LiveSpace, LiveUser } from "@/live/space";
import {
	activeStorage,
	isStorageConfigured,
	type ObsyncSettings,
} from "@/settings/model";
import { reportWarning } from "@/shared/diagnostics";
import { createStorageAdapter } from "@/storage";
import type { SyncController } from "@/sync/controller";
import type { LiveNotes } from "@/sync/live-notes";
import { type Space, spaceOf, VAULT_SPACE } from "@/sync/space";
import { base64ToBytes } from "@/utils/base64";

export interface LiveHost {
	app: App;
	passphrase: PassphraseManager;
	controller: SyncController;
	settings(): ObsyncSettings;
	/** The spaces as the records have them now, ahead of the next refresh. */
	partition(): readonly Space[];
}

/** How a share names its owner, and a participant invited without a name. */
const OWNER_NAME = "Owner";
const UNNAMED = "Participant";

/** Live editing wired to the workspace: which notes are open decides which rooms are joined. */
export function createLive(
	host: LiveHost,
	hub: HubConnection,
): {
	sessions: LiveSessions;
	notes(space: Space): LiveNotes;
	dispose(): void;
} {
	const { workspace, vault } = host.app;
	const agreed = new AgreedTexts(vault.adapter, vault.configDir);
	void agreed.prune();
	const liveSpace = createLiveSpaces(host);
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

/**
 * The vault goes live under the passphrase's keys, a share under its own record's
 * key. Paused and read-only shares stay cold: the hub refuses a read-only person's writes.
 */
function createLiveSpaces(
	host: LiveHost,
): (space: Space) => Promise<LiveSpace | null> {
	const shareKeys = new Map<string, Promise<LiveKeys>>();
	return async (space) => {
		const settings = host.settings();
		if (!settings.realtimeSync || !settings.liveEditing) return null;
		if (space.paused || space.readOnly) return null;
		if (space.root === VAULT_SPACE.root) {
			const keys = await liveKeys(host);
			// One person across the vault: each device is told apart by its own name and colour.
			const { id, name } = host.controller.currentDevice();
			const user = userOf(id, name);
			return (
				keys && { id: space.id, root: space.root, keys, person: OWNER, user }
			);
		}
		const record = settings.spaces.find((each) => each.id === space.id);
		if (!record || record.closed) return null;
		const memo = `${record.id}|${record.key}`;
		const keys =
			shareKeys.get(memo) ?? deriveLiveKeys(base64ToBytes(record.key));
		shareKeys.set(memo, keys);
		const { access } = record;
		const invited = access.kind === "participant";
		const person = invited ? access.participantId : OWNER;
		const name = invited ? access.personName || UNNAMED : OWNER_NAME;
		// Coloured by person, so a cursor matches the tint of that person's text.
		const user = userOf(person, name);
		return { id: space.id, root: space.root, keys: await keys, person, user };
	};
}

/** Never prompts: live editing waits for a passphrase the sync already knows. */
async function liveKeys(host: LiveHost): Promise<LiveKeys | null> {
	const settings = host.settings();
	if (!settings.realtimeSync || !settings.liveEditing) return null;
	if (!isStorageConfigured(settings)) return null;
	const { passphrase } = host;
	const cached = passphrase.liveKeys();
	if (cached || !passphrase.has()) return cached;
	try {
		await passphrase.resolveKey(createStorageAdapter(activeStorage(settings)));
	} catch (err) {
		reportWarning("Live editing could not unlock the vault key.", err);
		return null;
	}
	return passphrase.liveKeys();
}

function userOf(colorKey: string, name: string): LiveUser {
	return { name, ...authorColors(colorKey) };
}
