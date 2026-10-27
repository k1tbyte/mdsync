import type { App } from "obsidian";
import type { MdsyncSettings } from "@/core/settings";
import type { SyncController } from "@/features/sync";

/** What the editor's change signs need from the plugin. */
export interface EditorSignsHost {
	readonly app: App;
	settings: MdsyncSettings;
	readonly controller: SyncController;
}
