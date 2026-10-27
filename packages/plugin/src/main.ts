import { Plugin } from "obsidian";
import { bootstrapPluginRuntime, disposePluginRuntime } from "@/app/bootstrap";
import { registerCommands } from "@/app/commands";
import {
	registerHashCarry,
	registerStatePersistenceFlush,
	registerWorkspaceMenus,
} from "@/app/events";
import type { PluginHost } from "@/app/host";
import { registerProtocolHandlers } from "@/app/protocols";
import { createRealtime, type Realtime } from "@/app/realtime";
import { DEFAULT_SETTINGS, mergeSettings } from "@/app/settings";
import { SettingsEnvelope } from "@/app/settings-envelope";
import { createStorageRefused } from "@/app/storage-refused";
import {
	refreshOpenHistoryViewsAfterPush,
	refreshOpenSourceControlViews,
	registerPluginUi,
} from "@/app/views";
import { SOURCE_CONTROL_VIEW_TYPE } from "@/core/constants";
import { DeviceKey } from "@/core/crypto";
import type { LogService } from "@/core/logs";
import type { MdsyncSettings } from "@/core/settings";
import { reportWarning } from "@/core/shared";
import { notifyAction, notifyInfo } from "@/core/ui";
import { loadNodeFs } from "@/core/vault";
import { registerEditorSigns, type SignsHandle } from "@/features/editor-signs";
import type { IndicatorHandle } from "@/features/explorer";
import { registerLinkPaths, SharedLinks } from "@/features/links";
import { createDeletedElsewhere } from "@/features/live";
import type { Unseen } from "@/features/presence";
import {
	type CursorFollow,
	markTheirs,
	registerFollows,
	registerUnseen,
} from "@/features/presence";
import { type RelayUpdate, registerRelayUpdate } from "@/features/relay";
import type { MdsyncSettingTab } from "@/features/settings";
import {
	closeSetupWizard,
	type ESetupStep,
	openSetupWizard,
} from "@/features/setup";
import {
	openSourceControlChanges,
	openSourceControlView,
} from "@/features/source-control";
import type { SpaceRecords } from "@/features/spaces";
import {
	createAccessEnded,
	createShareRegistration,
	createSpaceGone,
	registerReadOnlyLock,
	registerShareRenames,
} from "@/features/spaces";
import { isStorageConfigured } from "@/features/storage";
import type { SyncController, WriteJournal } from "@/features/sync";
import {
	canSync,
	DeviceName,
	type IgnoreStateHandle,
	type PassphraseManager,
	registerIgnoreState,
	registerScheduler,
	registerVaultAdoptionPrompt,
	type StatePersister,
} from "@/features/sync";
import { SettingsTransferController } from "@/features/transfer";

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
	follows!: CursorFollow;
	relayUpdate!: RelayUpdate;
	readonly sharedLinks = new SharedLinks({
		settings: () => this.settings,
		save: () => this.saveSettings(),
		author: () => this.controller.currentDevice().id,
		// The vault refresh trades the links.
		announce: () => {
			if (isStorageConfigured(this.settings)) void this.controller.refresh();
		},
	});
	private settingsTab?: MdsyncSettingTab;
	private deviceKey!: DeviceKey;
	private envelope!: SettingsEnvelope;
	private statePersister!: StatePersister;
	private journal?: WriteJournal;
	private scopeRefreshTimer: number | null = null;
	private editorSigns: SignsHandle | null = null;
	private fileIndicators: IndicatorHandle | null = null;
	private refreshStatusBar: (() => void) | null = null;
	unloaded = false;
	private freshInstall = false;
	/** One settings write at a time: two in flight may land the older one last. */
	private savingSettings: Promise<void> = Promise.resolve();

	async onload(): Promise<void> {
		await loadNodeFs();
		const { secretStorage, vault } = this.app;
		this.deviceKey = new DeviceKey(
			secretStorage,
			vault.adapter,
			vault.configDir,
		);
		this.envelope = new SettingsEnvelope(this.deviceKey);
		await this.loadSettings();
		const registerShare = createShareRegistration(this);
		const runtime = await bootstrapPluginRuntime({
			app: this.app,
			settings: this.settings,
			deviceKey: this.deviceKey,
			links: this.sharedLinks,
			onPushComplete: (space) => {
				this.realtime.hub.signal(space.id);
				refreshOpenHistoryViewsAfterPush(this);
			},
			onSpaceRefreshed: (space) => void registerShare(space),
			onShareRefused: createAccessEnded(this),
			onStorageRefused: createStorageRefused(this),
			onSpaceGone: createSpaceGone(this),
			onUnindexed: (count) =>
				notifyInfo(
					`Obsidian has not loaded ${count} files that are on disk. MDSync syncs them; restart Obsidian to see them.`,
				),
			onDeletionsHeld: (space, paths) =>
				notifyAction(
					`Auto-push held back ${paths.length} deleted files${space.root ? ` in "${space.root}"` : ""}. Review them before they sync.`,
					"Review",
					() => void this.openChanges(),
				),
			onTheirsPulled: (space, paths) =>
				markTheirs(this, this.unseen, space, paths),
			onNoStorage: () =>
				notifyAction("Set up storage to sync.", "Set up", () =>
					this.openSetup(),
				),
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
		this.journal = runtime.journal;
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
			journal: runtime.journal,
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
		this.follows = registerFollows(this);
		this.ignoreState = registerIgnoreState(this);

		registerVaultAdoptionPrompt(this, this.controller);
		this.relayUpdate = registerRelayUpdate(this);

		const registeredUi = registerPluginUi(this, this.controller);
		this.settingsTab = registeredUi.settingsTab;
		this.fileIndicators = registeredUi.fileIndicators;
		this.refreshStatusBar = registeredUi.refreshStatusBar;
		this.editorSigns = registerEditorSigns(this);
		registerReadOnlyLock(this);

		registerCommands(this, registeredUi.openNoteMenu);
		registerHashCarry(this, this.statePersister);
		registerScheduler(this, this.controller);
		// Auto-sync may be off: a compare ends what the load put back, and only then can its room open.
		this.app.workspace.onLayoutReady(() => {
			if (runtime.journal.hasCutShort() && canSync(this.settings)) {
				void this.controller.refresh();
			}
		});
		registerWorkspaceMenus(this);
		registerShareRenames(this);
		registerLinkPaths(this);
		registerStatePersistenceFlush(this, this.statePersister);

		// Re-render the open Settings tab so auth status updates live.
		registerProtocolHandlers(this, () => this.settingsTab?.update());

		if (this.freshInstall) {
			// Saved first: closing the wizard must not bring it back on every start.
			await this.saveSettings();
			this.app.workspace.onLayoutReady(() => this.openSetup());
		} else if (this.envelope.unreadable()) {
			this.app.workspace.onLayoutReady(() =>
				notifyAction(
					"MDSync cannot read its saved connection on this device: this vault was copied or moved, or Obsidian's keychain was reset. Import a setup link from another device, or set up again.",
					"Set up",
					() => this.openSetup(),
				),
			);
		}
	}

	onunload(): void {
		this.unloaded = true;
		if (this.scopeRefreshTimer !== null) {
			window.clearTimeout(this.scopeRefreshTimer);
			this.scopeRefreshTimer = null;
		}
		// Isolated: one throwing teardown must not leave the rest running after unload.
		safely(() => closeSetupWizard());
		safely(() => this.editorSigns?.dispose());
		this.editorSigns = null;
		this.fileIndicators = null;
		this.refreshStatusBar = null;
		safely(() => this.statePersister?.dispose());
		safely(() => this.journal?.dispose());
		safely(() => this.controller?.dispose());
		safely(() => this.passphrase?.dispose());
		safely(() => this.realtime?.dispose());
		safely(() => this.logs?.dispose());
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Record<string, unknown> | null;
		this.freshInstall = data === null;
		const { stored, inTheClear } = await this.envelope.open(data);
		this.settings = mergeSettings(stored);
		// Sealed now, not at the next change: the secrets of an earlier build must not linger in the clear.
		if (inTheClear) await this.writeSettings();
	}

	async saveSettings(): Promise<void> {
		await this.writeSettings();
		// Any settings write can change the room, the relay credentials or a note's space.
		this.realtime.refresh();
	}

	private writeSettings(): Promise<void> {
		const save = this.savingSettings.then(async () =>
			this.saveData(await this.envelope.seal(this.settings)),
		);
		this.savingSettings = save.catch(() => undefined);
		return save;
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

	openSetup(step?: ESetupStep): void {
		// The settings tab under the wizard, the Changes tab's setup prompt and the status bar would keep showing what it replaced.
		openSetupWizard(this, step, () => {
			this.settingsTab?.update();
			this.refreshSourceControlView();
			this.refreshStatusBar?.();
		});
	}

	async openSourceControl(): Promise<void> {
		await openSourceControlView(this.app, SOURCE_CONTROL_VIEW_TYPE);
	}

	openChanges(): Promise<void> {
		return openSourceControlChanges(this);
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
		this.settingsTab?.update();
		this.scheduleScopeRefresh("Settings imported.");
	}
}
