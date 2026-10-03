import { Plugin } from "obsidian";

import { registerCommands } from "@/commands";
import {
	DeviceName,
	type LogService,
	type PassphraseManager,
	type StatePersister,
} from "@/core";
import { registerReadOnlyLock } from "@/editor/read-only";
import { registerEditorSigns, type SignsHandle } from "@/editor/signs";
import type { Unseen } from "@/presence";
import {
	canSync,
	DEFAULT_SETTINGS,
	type MdsyncSettings,
	mergeSettings,
} from "@/settings/model";
import type { MdsyncSettingTab } from "@/settings/tab";
import { SettingsTransferController } from "@/settings/transfer-controller";
import { reportWarning } from "@/shared";
import type { SpaceRecords } from "@/spaces";
import type { SyncController } from "@/sync/controller";
import { registerScheduler } from "@/sync/scheduler";
import {
	createAccessEnded,
	createDeletedElsewhere,
	createSpaceGone,
	type IndicatorHandle,
	notifyInfo,
} from "@/ui";
import { loadNodeFs } from "@/vault/symlinks";
import {
	bootstrapPluginRuntime,
	disposePluginRuntime,
} from "./plugin/bootstrap";
import {
	registerHashCarry,
	registerIgnoreFileRefresh,
	registerStatePersistenceFlush,
	registerWorkspaceMenus,
} from "./plugin/events";
import type { PluginHost } from "./plugin/host";
import {
	type IgnoreStateHandle,
	registerIgnoreState,
} from "./plugin/ignore-state";
import { registerProtocolHandlers } from "./plugin/protocols";
import { createRealtime, type Realtime } from "./plugin/realtime";
import { registerShareRenames } from "./plugin/share-moves";
import { createShareRegistration } from "./plugin/share-registration";
import {
	refreshOpenHistoryViewsAfterPush,
	refreshOpenSourceControlViews,
	registerPluginUi,
} from "./plugin/ui";
import { markTheirs, registerUnseen } from "./plugin/unseen";
import { registerVaultAdoptionPrompt } from "./plugin/vault-adoption";

const SCOPE_REFRESH_DEBOUNCE_MS = 800;

/** Runs a teardown step without letting its failure abort the rest. */
function safely(step: () => void): void {
	try {
		step();
	} catch (err) {
		reportWarning("A teardown step failed during unload.", err);
	}
}

export default class MdsyncPlugin extends Plugin implements PluginHost {
	settings: MdsyncSettings = DEFAULT_SETTINGS;
	controller!: SyncController;
	logs!: LogService;
	passphrase!: PassphraseManager;
	realtime!: Realtime;
	device!: DeviceName;
	transfer!: SettingsTransferController;
	ignoreState!: IgnoreStateHandle;
	spaces!: SpaceRecords;
	unseen!: Unseen;
	private settingsTab?: MdsyncSettingTab;
	private statePersister!: StatePersister;
	private scopeRefreshTimer: number | null = null;
	private editorSigns: SignsHandle | null = null;
	private fileIndicators: IndicatorHandle | null = null;
	private unloaded = false;
	/** One settings write at a time: two in flight may land the older one last. */
	private savingSettings: Promise<void> = Promise.resolve();

	async onload(): Promise<void> {
		await loadNodeFs();
		await this.loadSettings();
		const registerShare = createShareRegistration(this);
		const runtime = await bootstrapPluginRuntime({
			app: this.app,
			settings: this.settings,
			onPushComplete: (space) => {
				this.realtime.hub.signal(space.id);
				refreshOpenHistoryViewsAfterPush(this);
			},
			onSpaceRefreshed: (space) => void registerShare(space),
			onShareRefused: createAccessEnded(this),
			onSpaceGone: createSpaceGone(this),
			onUnindexed: (count) =>
				notifyInfo(
					`Obsidian has not loaded ${count} files that are on disk. MDSync syncs them; restart Obsidian to see them.`,
				),
			onTheirsPulled: (space, paths) =>
				markTheirs(this, this.unseen, space, paths),
			persistSettings: () => this.saveSettings(),
			liveNotes: (space) => this.realtime?.liveNotes(space),
		});
		// Obsidian can unload mid-onload (it awaits a 3 MB state file); a teardown registered past that point
		// never runs and leaks sockets, timers and views.
		if (this.unloaded) {
			disposePluginRuntime(runtime);
			return;
		}
		this.logs = runtime.logs;
		this.statePersister = runtime.statePersister;
		this.spaces = runtime.spaces;
		this.passphrase = runtime.passphraseManager;
		this.controller = runtime.controller;
		this.unseen = registerUnseen(this);
		this.realtime = createRealtime({
			app: this.app,
			passphrase: this.passphrase,
			controller: this.controller,
			settings: () => this.settings,
			spaces: this.spaces,
			onDeletedElsewhere: createDeletedElsewhere(this),
		});
		this.device = new DeviceName(this.statePersister, () =>
			this.realtime.hub.restart(),
		);
		this.transfer = new SettingsTransferController({
			app: this.app,
			settings: this.settings,
			passphrase: this.passphrase,
			saveSettings: () => this.saveSettings(),
			onSettingsReplaced: () => this.onSettingsReplaced(),
		});
		this.realtime.hub.restart();
		this.ignoreState = registerIgnoreState(this);

		registerVaultAdoptionPrompt(this, this.controller);

		const registeredUi = registerPluginUi(this, this.controller);
		this.settingsTab = registeredUi.settingsTab;
		this.fileIndicators = registeredUi.fileIndicators;
		this.editorSigns = registerEditorSigns(this);
		registerReadOnlyLock(this);

		registerCommands(this, registeredUi.openNoteMenu);
		registerHashCarry(this, this.statePersister);
		registerScheduler(this, this.controller);
		registerWorkspaceMenus(this);
		registerShareRenames(this);
		registerIgnoreFileRefresh(this);
		registerStatePersistenceFlush(this, this.statePersister);

		// Re-render the open Settings tab so auth status updates live.
		registerProtocolHandlers(this, () => this.settingsTab?.display());
	}

	onunload(): void {
		this.unloaded = true;
		if (this.scopeRefreshTimer !== null) {
			window.clearTimeout(this.scopeRefreshTimer);
			this.scopeRefreshTimer = null;
		}
		// Isolated: one throwing teardown must not leave the rest running after unload.
		safely(() => this.editorSigns?.dispose());
		this.editorSigns = null;
		this.fileIndicators = null;
		safely(() => this.statePersister?.dispose());
		safely(() => this.controller?.dispose());
		safely(() => this.passphrase?.dispose());
		safely(() => this.realtime?.dispose());
		safely(() => this.logs?.dispose());
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<MdsyncSettings> | null;
		this.settings = mergeSettings(data);
	}

	async saveSettings(): Promise<void> {
		const save = this.savingSettings.then(() => this.saveData(this.settings));
		this.savingSettings = save.catch(() => undefined);
		await save;
		// Any settings write can change the room, the relay credentials or a note's space.
		this.realtime.refresh();
	}

	async resetLocalState(): Promise<void> {
		this.controller.cancel();
		await this.controller.between(() => this.statePersister.reset());
		this.controller.invalidate("Local state reset.");
	}

	refreshEditorSigns(enabled: boolean): void {
		this.editorSigns?.refresh(enabled);
	}

	refreshFileIndicators(enabled: boolean): void {
		this.fileIndicators?.refresh(enabled);
	}

	refreshSourceControlView(): void {
		refreshOpenSourceControlViews(this);
	}

	scheduleScopeRefresh(reason = "Sync scope changed."): void {
		const snapshot = this.controller.getSnapshot();
		// A first refresh still running read the old scope: drop it too.
		if (!snapshot.result && snapshot.lastCompareAt === null && !snapshot.busy) {
			return;
		}
		this.controller.invalidate(reason);
		if (!canSync(this.settings)) return;
		if (this.scopeRefreshTimer !== null) {
			window.clearTimeout(this.scopeRefreshTimer);
		}
		this.scopeRefreshTimer = window.setTimeout(() => {
			this.scopeRefreshTimer = null;
			void this.controller.refresh();
		}, SCOPE_REFRESH_DEBOUNCE_MS);
	}

	/**
	 * Imported settings change the backend and relay; services would otherwise keep the old configuration
	 * until restart.
	 */
	private onSettingsReplaced(): void {
		void this.ignoreState.refresh();
		this.realtime.hub.restart();
		this.refreshEditorSigns(this.settings.showEditorChangeSigns);
		this.refreshFileIndicators(this.settings.showFileExplorerIndicators);
		this.refreshSourceControlView();
		this.settingsTab?.display();
		this.scheduleScopeRefresh("Settings imported.");
	}
}
