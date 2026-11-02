import type { App } from "obsidian";
import type { SettingsHost } from "@/core/settings";
import type { SettingsTransferController } from "./transfer-controller";

/** What device transfer needs from the plugin. */
export interface TransferHost extends SettingsHost {
	readonly app: App;
	readonly transfer: SettingsTransferController;
}
