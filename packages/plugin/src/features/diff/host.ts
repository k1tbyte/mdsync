import type { App } from "obsidian";
import type { SyncController } from "@/features/sync";

/** What the diff view needs from the plugin. */
export interface DiffHost {
	readonly app: App;
	readonly controller: SyncController;
	openSourceControl(): Promise<void>;
}
