import type { App } from "obsidian";

import type { DeviceName, LogService, PassphraseManager } from "@/core";
import type { SharedLinks } from "@/links";
import type { Unseen } from "@/presence";
import type { MdsyncSettings } from "@/settings/model";
import type { ESetupStep } from "@/settings/setup/steps";
import type { SettingsTransferController } from "@/settings/transfer-controller";
import type { SpaceRecords } from "@/spaces";
import type { SyncController } from "@/sync/controller";

import type { IgnoreStateHandle } from "./ignore-state";
import type { Realtime } from "./realtime";

/**
 * The plugin surface feature modules may use; Obsidian's registration API stays on the Plugin, so registering
 * modules take `Plugin & PluginHost`.
 */
export interface PluginHost {
	readonly app: App;
	settings: MdsyncSettings;
	readonly controller: SyncController;
	readonly logs: LogService;
	readonly passphrase: PassphraseManager;
	readonly realtime: Realtime;
	readonly device: DeviceName;
	readonly transfer: SettingsTransferController;
	readonly ignoreState: IgnoreStateHandle;
	readonly spaces: SpaceRecords;
	readonly unseen: Unseen;
	readonly sharedLinks: SharedLinks;

	saveSettings(): Promise<void>;
	scheduleScopeRefresh(reason?: string): void;
	resetLocalState(): Promise<void>;
	refreshEditorSigns(enabled: boolean): void;
	refreshFileIndicators(enabled: boolean): void;
	refreshSourceControlView(): void;
	/** The setup wizard, at `step` or where this device's setup stopped. */
	openSetup(step?: ESetupStep): void;
}
