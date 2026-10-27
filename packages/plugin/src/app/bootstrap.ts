import type { App } from "obsidian";
import type { DeviceKey } from "@/core/crypto";
import { LogService } from "@/core/logs";
import { isStorageConfigured, type MdsyncSettings } from "@/core/settings";
import { reportWarning } from "@/core/shared";
import { askPassphrase, notifyError, notifyInfo } from "@/core/ui";
import type { SharedLinks } from "@/features/links";
import { createMoveFollower, SpaceRecords } from "@/features/spaces";
import type { LiveNotes } from "@/features/sync";
import {
	fetchRemoteManifest,
	PassphraseManager,
	restoreCutShort,
	type Space,
	StatePersister,
	SyncController,
	VAULT_SPACE,
	WriteJournal,
} from "@/features/sync";
import { createSessionOpeners } from "./session-factory";

export interface PluginRuntime {
	controller: SyncController;
	logs: LogService;
	passphraseManager: PassphraseManager;
	statePersister: StatePersister;
	spaces: SpaceRecords;
	journal: WriteJournal;
}

interface BootstrapPluginRuntimeOptions {
	app: App;
	settings: MdsyncSettings;
	deviceKey: DeviceKey;
	/** Traded with the vault storage on every full refresh, after the records. */
	links: Pick<SharedLinks, "sync">;
	/** Also for a published space record: other devices learn of shares from the vault. */
	onPushComplete?: (space: Space) => void;
	onSpaceRefreshed?: (space: Space) => void;
	onShareRefused?: (space: Space) => void;
	onStorageRefused?: (space: Space) => void;
	onSpaceGone?: (space: Space) => void;
	onUnindexed?: (count: number) => void;
	onDeletionsHeld?: (space: Space, paths: readonly string[]) => void;
	onTheirsPulled?: (space: Space, paths: readonly string[]) => void;
	onNoStorage: () => void;
	persistSettings: () => Promise<void>;
	liveNotes?: (space: Space) => LiveNotes | undefined;
}

export async function bootstrapPluginRuntime(
	options: BootstrapPluginRuntimeOptions,
): Promise<PluginRuntime> {
	const { app, settings, deviceKey, persistSettings, liveNotes } = options;
	const { adapter, configDir } = app.vault;
	const logs = new LogService(adapter, configDir);
	await logs.load();

	const statePersister = await StatePersister.load(adapter, configDir);
	const journal = await WriteJournal.load(adapter, configDir);
	const passphraseManager = new PassphraseManager(
		() => askPassphrase(app),
		adapter,
		configDir,
		settings,
		deviceKey,
		persistSettings,
	);

	const spaces = new SpaceRecords(settings, persistSettings);
	// Offline the first refresh never reaches its scan.
	await restoreCutShort(adapter, journal, spaces.partition());
	const { openSession, openLocal } = createSessionOpeners({
		app,
		settings,
		spaces,
		passphrase: passphraseManager,
		state: statePersister,
		logs,
		notify: notifyInfo,
		onNoStorage: options.onNoStorage,
		persistSettings,
		liveNotes,
		journal,
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
				// A link that fails to trade must not hold up the files.
				const traded = await options.links
					.sync(storage, key)
					.catch((err: unknown) => {
						reportWarning("Share links did not sync.", err);
						return false;
					});
				if (published || traded) options.onPushComplete?.(VAULT_SPACE);
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
			const partition = spaces.partition();
			journal.adopt(partition);
			return partition;
		},
		openSession,
		openLocal,
		persistState: (state) => statePersister.persist(state),
		getState: () => statePersister.state,
		logInfo: (op, msg, details) => logs.info(op, msg, details),
		logWarn: (op, msg, details) => logs.warn(op, msg, details),
		logError: (op, msg, details) => logs.error(op, msg, details),
		onPushComplete: options.onPushComplete,
		onSpaceRefreshed: options.onSpaceRefreshed,
		onShareRefused: options.onShareRefused,
		onStorageRefused: options.onStorageRefused,
		onSpaceGone: options.onSpaceGone,
		onUnindexed: options.onUnindexed,
		autoDeleteLimit: () =>
			settings.confirmBulkDeletes ? settings.bulkDeleteLimit : null,
		onDeletionsHeld: options.onDeletionsHeld,
		onTheirsPulled: options.onTheirsPulled,
	});

	return {
		controller,
		logs,
		passphraseManager,
		statePersister,
		spaces,
		journal,
	};
}

/** For an onload that has to abandon what it built, see `MdsyncPlugin.onload`. */
export function disposePluginRuntime(runtime: PluginRuntime): void {
	runtime.statePersister.dispose();
	runtime.journal.dispose();
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
