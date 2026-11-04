import type { App } from "obsidian";
import type { SyncController } from "@/features/sync";

export interface DiffHost {
	readonly app: App;
	readonly controller: SyncController;
	openSourceControl(): Promise<void>;
}
