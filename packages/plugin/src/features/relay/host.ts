import type { App } from "obsidian";
import type { SettingsHost } from "@/core/settings";
import type { HubConnection } from "./connection";

/** What the relay needs from the plugin. */
export interface RelayHost extends SettingsHost {
	readonly app: App;
	readonly realtime: { readonly hub: HubConnection };
	/** Work that outlives its view, like a relay deploy, stops here. */
	readonly unloaded: boolean;
	openSetup(step: "relay"): void;
}
