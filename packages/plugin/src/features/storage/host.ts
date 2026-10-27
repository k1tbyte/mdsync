import type { App } from "obsidian";
import type { SettingsHost } from "@/core/settings";

/** What storage needs from the plugin. */
export interface StorageHost extends SettingsHost {
	readonly app: App;
}
