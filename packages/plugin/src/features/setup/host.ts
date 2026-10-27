import type { LiveSessions } from "@/features/live";
import type { RelayHost } from "@/features/relay";
import type { SpacesHost } from "@/features/spaces";
import type { PassphraseManager } from "@/features/sync";
import type { SettingsTransferController } from "@/features/transfer";

/** What the setup wizard needs from the plugin. */
export interface SetupHost extends SpacesHost, RelayHost {
	readonly passphrase: PassphraseManager;
	readonly transfer: SettingsTransferController;
	readonly realtime: SpacesHost["realtime"] &
		RelayHost["realtime"] & { readonly live: LiveSessions };
}
