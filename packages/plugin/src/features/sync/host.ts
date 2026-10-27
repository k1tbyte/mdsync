import type { App } from "obsidian";
import type { SettingsHost } from "@/core/settings";
import type { SyncController } from "./controller";
import type { PassphraseManager } from "./remote/passphrase-manager";
import type { Space } from "./remote/space";
import type { IgnoreStateHandle } from "./scope/ignore-state";

/** What sync's commands, menus and sections need from the plugin. */
export interface SyncHost extends SettingsHost {
	readonly app: App;
	readonly controller: SyncController;
	readonly ignoreState: IgnoreStateHandle;
	readonly passphrase: PassphraseManager;
	/** The records' partition, ahead of the next refresh. */
	readonly spaces: { partition(): readonly Space[] };
	resetLocalState(): Promise<void>;
	openSourceControl(): Promise<void>;
	openChanges(): Promise<void>;
}
