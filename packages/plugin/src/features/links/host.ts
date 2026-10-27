import type { App } from "obsidian";
import type { SettingsHost } from "@/core/settings";
import type { SharedLinks } from "./shared-links";

/** What share links need from the plugin. */
export interface LinksHost extends SettingsHost {
	readonly app: App;
	readonly sharedLinks: SharedLinks;
	openSetup(step: "relay"): void;
}
