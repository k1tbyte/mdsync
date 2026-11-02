import type { App } from "obsidian";
import type { LogService } from "@/core/logs";
import type { MdsyncSettings } from "@/core/settings";
import type { SharedLinks } from "@/features/links";
import type { CursorFollow, Unseen } from "@/features/presence";
import type { RelayUpdate } from "@/features/relay";
import type { ESetupStep } from "@/features/setup";
import type { SpaceRecords } from "@/features/spaces";
import type {
	DeviceName,
	IgnoreStateHandle,
	PassphraseManager,
	SyncController,
} from "@/features/sync";
import type { SettingsTransferController } from "@/features/transfer";
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
	readonly follows: CursorFollow;
	readonly sharedLinks: SharedLinks;
	readonly relayUpdate: RelayUpdate;
	/** Work that outlives its view, like a relay deploy, stops here. */
	readonly unloaded: boolean;

	saveSettings(): Promise<void>;
	scheduleScopeRefresh(reason?: string): void;
	resetLocalState(): Promise<void>;
	refreshEditorSigns(enabled: boolean): void;
	refreshFileIndicators(enabled: boolean): void;
	refreshSourceControlView(history?: boolean): void;
	/** The setup wizard, at `step` or where this device's setup stopped. */
	openSetup(step?: ESetupStep): void;
	openSourceControl(): Promise<void>;
	openChanges(): Promise<void>;
	/** The Timeline on the local day starting at `day`, else as it was left. */
	openTimeline(day?: number): Promise<void>;
}
