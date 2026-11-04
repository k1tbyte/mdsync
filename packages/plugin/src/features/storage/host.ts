import type { App } from "obsidian";
import type { SettingsHost } from "@/core/settings";

export interface StorageHost extends SettingsHost {
	readonly app: App;
}
