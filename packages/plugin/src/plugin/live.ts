import type { App, FileView, TFile, Vault, Workspace } from "obsidian";

import type { HubConnection } from "@/hub";
import {
	AgreedTexts,
	LIVE_VIEWS,
	LiveColdSync,
	LiveSessions,
	type LiveSpace,
} from "@/live";
import { personColor } from "@/shared/colors";
import { reportWarning } from "@/shared/diagnostics";
import type { SpaceRecords } from "@/spaces";
import type { LiveNotes } from "@/sync/live-notes";
import { type Space, spaceOf, VAULT_SPACE } from "@/sync/space";
import { renameInVault } from "@/vault/file-index";

import type { SpaceAccess, SpaceAccessHost } from "./space-access";

export interface LiveHost extends SpaceAccessHost {
	app: App;
	/** Its partition is the spaces as the records have them now, ahead of the next refresh. */
	spaces: Pick<SpaceRecords, "get" | "partition">;
	onDeletedElsewhere(path: string): void;
}

/** Live editing wired to the workspace: which notes are open decides which rooms are joined. */
export function createLive(
	host: LiveHost,
	hub: HubConnection,
	access: (space: Space) => Promise<SpaceAccess | null>,
	nameOf: (space: string, person: string) => string | null,
): {
	sessions: LiveSessions;
	notes(space: Space): LiveNotes;
	dispose(): Promise<void>;
} {
	const { vault } = host.app;
	const agreed = new AgreedTexts(vault.adapter, vault.configDir);
	void agreed.prune();
	const liveSpace = createLiveSpaces(host, access);
	const sessions = new LiveSessions({
		app: host.app,
		hub,
		liveSpace: (path) => liveSpace(spaceOf(host.spaces.partition(), path)),
		agreed,
		baseText: (path) => baseTextOf(host, path),
		moveFile: (from, to) => moveFile(vault, from, to),
		authorsShown: () => host.settings().showLiveAuthors,
		nameOf,
	});
	const stopWatching = refreshOnChanges(host.app, hub, sessions);
	const stopFlushing = flushAgreedWhenLeaving(agreed);
	return {
		sessions,
		// Bound to the sync session's own space, whose partition is fixed per refresh.
		notes: (space) =>
			new LiveColdSync({
				rooms: sessions,
				agreed,
				space: space.id,
				live: () => liveSpace(space),
				kept: (path) => host.onDeletedElsewhere(path),
			}),
		dispose() {
			stopWatching();
			stopFlushing();
			return sessions.dispose();
		},
	};
}

function refreshOnChanges(
	{ workspace, vault, metadataCache }: App,
	hub: HubConnection,
	sessions: LiveSessions,
): () => void {
	const refresh = () => void sessions.refresh();
	const refs = [
		workspace.on("layout-change", refresh),
		workspace.on("active-leaf-change", refresh),
		workspace.on("file-open", refresh),
	];
	// A rename fires no workspace event: the room moves with its file.
	const renamed = vault.on("rename", refresh);
	// A note shown before Obsidian indexed it waits cold for its kind.
	const indexed = metadataCache.on("changed", (file) => {
		if (sessions.spaceOf(file.path) === null && isShown(workspace, file)) {
			refresh();
		}
	});
	const unlisten = hub.listen({
		// The first connection may be what brings the key within reach.
		onConnectionChange: (connected) => connected && refresh(),
	});
	workspace.onLayoutReady(refresh);
	return () => {
		for (const ref of refs) workspace.offref(ref);
		metadataCache.offref(indexed);
		vault.offref(renamed);
		unlisten();
	};
}

function flushAgreedWhenLeaving(agreed: AgreedTexts): () => void {
	const flush = () => void agreed.flush();
	const flushWhenHidden = () => {
		if (document.visibilityState === "hidden") flush();
	};
	document.addEventListener("visibilitychange", flushWhenHidden);
	window.addEventListener("beforeunload", flush);
	return () => {
		document.removeEventListener("visibilitychange", flushWhenHidden);
		window.removeEventListener("beforeunload", flush);
	};
}

/** Live editing on top of the space's access. Paused shares stay cold; a read-only one's notes follow the room. */
function createLiveSpaces(
	host: LiveHost,
	access: (space: Space) => Promise<SpaceAccess | null>,
): (space: Space) => Promise<LiveSpace | null> {
	return async (space) => {
		if (!host.settings().liveEditing || space.paused) return null;
		const at = await access(space);
		if (!at) return null;
		const { keys, person, key, name, device } = at;
		// Coloured by key, so a cursor matches the tint of that person's text.
		const user = { key, name, color: personColor(key), device };
		const { id, root, readOnly } = space;
		return { id, root, keys, person, user, ...(readOnly ? { readOnly } : {}) };
	};
}

function isShown(workspace: Workspace, file: TFile): boolean {
	return Object.values(LIVE_VIEWS).some((type) =>
		workspace
			.getLeavesOfType(type)
			.some((leaf) => (leaf.view as FileView).file === file),
	);
}

/**
 * The cold baseline, the merge base for a note never agreed here. A note that
 * just became a share has none there yet: the vault's frozen entry is what
 * every copy of it grew from, where an empty base would double the text.
 */
export async function baseTextOf(
	host: Pick<LiveHost, "controller" | "spaces">,
	path: string,
): Promise<string | null> {
	const { controller } = host;
	const own = await controller.fileDiffs.loadBaselineForPath(path);
	if (own || spaceOf(host.spaces.partition(), path).id === VAULT_SPACE.id) {
		return own?.text ?? null;
	}
	// Deleted or new in the share: the frozen copy is not what it grew from.
	if (controller.remoteHas(path) === false) return null;
	const frozen = await controller.fileDiffs.loadBaselineForPath(
		path,
		VAULT_SPACE,
	);
	return frozen?.text ?? null;
}

async function moveFile(
	vault: Vault,
	from: string,
	to: string,
): Promise<boolean> {
	try {
		return await renameInVault(vault, from, to);
	} catch (err) {
		reportWarning("Could not follow a live note's rename.", err);
		return false;
	}
}
