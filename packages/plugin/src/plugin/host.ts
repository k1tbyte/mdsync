import type { App } from "obsidian";

import type { DeviceName, LogService, PassphraseManager } from "@/core";
import type { ObsyncSettings } from "@/settings/model";
import type { SettingsTransferController } from "@/settings/transfer-controller";
import type { SyncController } from "@/sync/controller";

import type { IgnoreStateHandle } from "./ignore-state";
import type { Realtime } from "./realtime";

/**
 * The plugin surface feature modules are allowed to reach for. Obsidian's own
 * registration API stays on the Plugin instance, so a module that registers
 * something takes `Plugin & PluginHost` instead.
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

	saveSettings(): Promise<void>;
	scheduleScopeRefresh(reason?: string): void;
	resetLocalState(): Promise<void>;
	refreshEditorSigns(enabled: boolean): void;
	refreshFileIndicators(enabled: boolean): void;
	refreshSourceControlView(): void;
}
