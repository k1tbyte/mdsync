import type { App } from "obsidian";
import type { SettingsHost } from "@/core/settings";
import type { SettingsTransferController } from "./transfer-controller";

export interface TransferHost extends SettingsHost {
	readonly app: App;
	readonly transfer: SettingsTransferController;
}
