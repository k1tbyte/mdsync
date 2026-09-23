import type { App, EventRef } from "obsidian";

import type { PassphraseManager } from "@/core";
import type { LiveKeys } from "@/crypto/live-keys";
import type { HubConnection } from "@/hub/connection";
import { AgreedTexts } from "@/live/agreed-texts";
import { LiveColdSync } from "@/live/cold-sync";
import { LiveSessions, type LiveUser } from "@/live/sessions";
import {
	activeStorage,
	isStorageConfigured,
	type ObsyncSettings,
} from "@/settings/model";
import { reportWarning } from "@/shared/diagnostics";
import { createStorageAdapter } from "@/storage";
import type { SyncController } from "@/sync/controller";
import type { LiveNotes } from "@/sync/live-notes";

export interface LiveHost {
	app: App;
	passphrase: PassphraseManager;
	controller: SyncController;
	settings(): ObsyncSettings;
}

/** Cursor hue per device, so the same laptop keeps its colour on every screen. */
const HUE_STEPS = 12;

/** Live editing wired to the workspace: which notes are open decides which rooms are joined. */
export function createLive(
	host: LiveHost,
	hub: HubConnection,
): { sessions: LiveSessions; notes: LiveNotes; dispose(): void } {
	const { workspace, vault } = host.app;
	const agreed = new AgreedTexts(vault.adapter, vault.configDir);
	void agreed.prune();
	const keys = () => liveKeys(host);
	const sessions = new LiveSessions({
		app: host.app,
		hub,
		keys,
		user: () => userOf(host.controller.currentDevice()),
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
		notes: new LiveColdSync({ rooms: sessions, agreed, keys }),
		dispose() {
			for (const ref of refs) workspace.offref(ref);
			unlisten();
			sessions.dispose();
		},
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

function userOf(device: { id: string; name: string }): LiveUser {
	let hash = 0;
	for (const char of device.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	const hue = (hash % HUE_STEPS) * (360 / HUE_STEPS);
	return {
		name: device.name,
		color: `hsl(${hue}, 70%, 50%)`,
		colorLight: `hsla(${hue}, 70%, 50%, 0.2)`,
	};
}
