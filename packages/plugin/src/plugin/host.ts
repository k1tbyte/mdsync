import type { App } from "obsidian";

import type { DeviceName, LogService, PassphraseManager } from "@/core";
import type { Unseen } from "@/presence";
import type { ObsyncSettings } from "@/settings/model";
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
	settings: ObsyncSettings;
	readonly controller: SyncController;
	readonly logs: LogService;
	readonly passphrase: PassphraseManager;
	readonly realtime: Realtime;
	readonly device: DeviceName;
	readonly transfer: SettingsTransferController;
	readonly ignoreState: IgnoreStateHandle;
	readonly spaces: SpaceRecords;
	readonly unseen: Unseen;

	saveSettings(): Promise<void>;
	scheduleScopeRefresh(reason?: string): void;
	resetLocalState(): Promise<void>;
	refreshEditorSigns(enabled: boolean): void;
	refreshFileIndicators(enabled: boolean): void;
	refreshSourceControlView(): void;
}
