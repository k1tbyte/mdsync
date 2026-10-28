import type { LogService } from "@/core/logs";
import type { LinksHost } from "@/features/links";
import type { LiveSessions } from "@/features/live";
import type { RelayHost, RelayUpdate } from "@/features/relay";
import type { SpacesHost } from "@/features/spaces";
import type { DeviceName, PassphraseManager } from "@/features/sync";
import type { TransferHost } from "@/features/transfer";

/** What the settings tab needs from the plugin: every section's host. */
export interface SettingsTabHost
	extends SpacesHost,
		LinksHost,
		RelayHost,
		TransferHost {
	readonly logs: LogService;
	readonly passphrase: PassphraseManager;
	readonly device: DeviceName;
	readonly relayUpdate: RelayUpdate;
	readonly realtime: SpacesHost["realtime"] &
		RelayHost["realtime"] & { readonly live: LiveSessions };
	openSetup(step?: "relay"): void;
	refreshEditorSigns(enabled: boolean): void;
	refreshFileIndicators(enabled: boolean): void;
	refreshSourceControlView(history?: boolean): void;
	openTimeline(day: number): Promise<void>;
}
