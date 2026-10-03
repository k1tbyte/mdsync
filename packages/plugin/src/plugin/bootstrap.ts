import type { App } from "obsidian";

import {
	createSessionOpener,
	LogService,
	PassphraseManager,
	StatePersister,
} from "@/core";
import { isStorageConfigured, type MdsyncSettings } from "@/settings/model";
import { reportWarning } from "@/shared";
import { SpaceRecords } from "@/spaces";
import { SyncController } from "@/sync/controller";
import type { LiveNotes } from "@/sync/live-notes";
import { fetchRemoteManifest } from "@/sync/manifest";
import { type Space, VAULT_SPACE } from "@/sync/space";
import { askPassphrase, notifyError, notifyInfo } from "@/ui";

import { createMoveFollower } from "./share-moves";

export interface PluginRuntime {
	controller: SyncController;
	logs: LogService;
	passphraseManager: PassphraseManager;
	statePersister: StatePersister;
	spaces: SpaceRecords;
}

interface BootstrapPluginRuntimeOptions {
	app: App;
	settings: MdsyncSettings;
	/** Also for a published space record: other devices learn of shares from the vault. */
	onPushComplete?: (space: Space) => void;
	onSpaceRefreshed?: (space: Space) => void;
	onShareRefused?: (space: Space) => void;
	onSpaceGone?: (space: Space) => void;
	onUnindexed?: (count: number) => void;
	onTheirsPulled?: (space: Space, paths: readonly string[]) => void;
	persistSettings: () => Promise<void>;
	liveNotes?: (space: Space) => LiveNotes | undefined;
}

export async function bootstrapPluginRuntime(
	options: BootstrapPluginRuntimeOptions,
): Promise<PluginRuntime> {
	const { app, settings, persistSettings, liveNotes } = options;
	const { adapter, configDir } = app.vault;
	const logs = new LogService(adapter, configDir);
	await logs.load();

	const statePersister = await StatePersister.load(adapter, configDir);
	const passphraseManager = new PassphraseManager(
		() => askPassphrase(app),
		adapter,
		configDir,
		settings,
	);

	const spaces = new SpaceRecords(settings, persistSettings);
	const openSession = createSessionOpener({
		app,
		settings,
		spaces,
		passphrase: passphraseManager,
		state: statePersister,
		logs,
		notify: notifyInfo,
		persistSettings,
		liveNotes,
	});

	const followMoves = createMoveFollower(app.vault, spaces, notifyError);
	const warnInert = createInertWarning(spaces);
	const controller = new SyncController({
		spaces: async () => {
			// Without vault storage (a guest) the records stay here until there is a vault to keep them in.
			if (isStorageConfigured(settings)) {
				const vault = await openSession(VAULT_SPACE, [VAULT_SPACE]);
				if (!vault) return null;
				const { storage, key } = vault;
				await spaces.admitJoined(storage, key, async () =>
					Object.keys(
						(await fetchRemoteManifest(storage, key, VAULT_SPACE.root))
							?.files ?? {},
					),
				);
				const { published, closed, left } = await spaces.sync(storage, key);
				if (published) options.onPushComplete?.(VAULT_SPACE);
				if (left.length > 0) {
					notifyError(
						`The vault storage changed: ${left.length} shared folder(s) stay with the previous one and sync here as plain folders until you switch back.`,
					);
				}
				// Queued behind this refresh: a share reopened later must not start from this baseline.
				for (const space of [...closed, ...left]) {
					controller
						.forgetSpace(space)
						.catch((err) =>
							reportWarning("A closed share kept its state.", err),
						);
				}
			}
			await followMoves();
			warnInert();
			return spaces.partition();
		},
		openSession,
		persistState: (state) => statePersister.persist(state),
		getState: () => statePersister.state,
		logInfo: (op, msg, details) => logs.info(op, msg, details),
		logWarn: (op, msg, details) => logs.warn(op, msg, details),
		logError: (op, msg, details) => logs.error(op, msg, details),
		onPushComplete: options.onPushComplete,
		onSpaceRefreshed: options.onSpaceRefreshed,
		onShareRefused: options.onShareRefused,
		onSpaceGone: options.onSpaceGone,
		onUnindexed: options.onUnindexed,
		onTheirsPulled: options.onTheirsPulled,
	});

	return {
		controller,
		logs,
		passphraseManager,
		statePersister,
		spaces,
	};
}

/** For an onload that has to abandon what it built, see `MdsyncPlugin.onload`. */
export function disposePluginRuntime(runtime: PluginRuntime): void {
	runtime.statePersister.dispose();
	runtime.controller.dispose();
	runtime.passphraseManager.dispose();
	runtime.logs.dispose();
}

/** Once per record and session: two devices shared one folder offline, and this one lost. */
function createInertWarning(spaces: SpaceRecords): () => void {
	const warned = new Set<string>();
	return () => {
		for (const { id, name, root } of spaces.inert()) {
			if (warned.has(id)) continue;
			warned.add(id);
			notifyError(
				`"${name}" is not syncing: another shared folder already holds "${root}". Stop sharing it in the Sync settings.`,
			);
		}
	};
}
