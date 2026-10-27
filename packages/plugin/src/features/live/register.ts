import type { App, FileView, TFile, Vault, Workspace } from "obsidian";
import { personColor, reportWarning } from "@/core/shared";
import { renameInVault } from "@/core/vault";
import type { HubConnection } from "@/features/relay";
import type {
	SpaceAccess,
	SpaceAccessHost,
	SpaceRecords,
} from "@/features/spaces";
import type { LiveNotes, WriteJournal } from "@/features/sync";
import { type Space, spaceOf, VAULT_SPACE } from "@/features/sync";
import { AgreedTexts } from "./cold/agreed-texts";
import { LiveColdSync } from "./cold/cold-sync";
import { LIVE_VIEWS } from "./doc-types";
import { LiveSessions } from "./workspace/sessions";
import type { LiveSpace } from "./workspace/space";

export interface LiveHost extends SpaceAccessHost {
	app: App;
	/** Its partition is the spaces as the records have them now, ahead of the next refresh. */
	spaces: Pick<SpaceRecords, "get" | "partition">;
	journal: Pick<WriteJournal, "writeAt">;
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
	notes: (space: Space) => LiveNotes;
	dispose(): Promise<void>;
} {
	const { vault } = host.app;
	const agreed = new AgreedTexts(vault.adapter, vault.configDir);
	void agreed.prune();
	const liveSpace = createLiveSpaces(host, access);
	const sessions = new LiveSessions({
		app: host.app,
		hub,
		liveSpace: async (path) => {
			const space = spaceOf(host.spaces.partition(), path);
			const write = host.journal.writeAt(space, path);
			// A room reads part of a write as edits and sends them everywhere: none opens under one, none stays on one cut short.
			if (write === "cut" || (write && sessions.spaceOf(path) === null)) {
				return null;
			}
			return liveSpace(space);
		},
		agreed,
		baseText: (path) => baseTextOf(host, path),
		moveFile: (from, to) => moveFile(vault, from, to),
		authorsShown: () => host.settings().showLiveAuthors,
		nameOf,
		sendEvery: () => host.settings().liveSendMs,
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
 * The merge base for a note never agreed here. A note that just became a share falls back to the vault's
 * frozen entry, which every copy grew from; an empty base would double the text.
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
