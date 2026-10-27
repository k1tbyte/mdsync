import type { SettingDefinitionGroup } from "obsidian";

import { type FieldContext, group, introRow } from "@/core/settings";
import { notifyInfo, reportError } from "@/core/ui";
import { showSettingsTransferExport } from "./settings-transfer-export-modal";
import { askSettingsTransferInput } from "./settings-transfer-modal";

export function deviceTransferSection(
	ctx: FieldContext,
): SettingDefinitionGroup {
	const { plugin } = ctx;
	return group("Device transfer", [
		introRow(
			"Export or import compact encrypted sync settings. Local-only display preferences stay on each device.",
		),
		{
			name: "Export setup",
			desc: "Create a compact encrypted link and QR code for another device.",
			render: (setting) => {
				setting.addButton((button) =>
					button.setButtonText("Export").onClick(() =>
						showSettingsTransferExport(plugin.app, {
							createPackage: (options) =>
								plugin.transfer.createPackage(options),
						}),
					),
				);
			},
		},
		{
			name: "Import setup",
			desc: "Paste an encrypted setup link and replace storage, sync scope, ignore, and automation settings.",
			render: (setting) => {
				setting.addButton((button) =>
					button
						.setButtonText("Import")
						.setDestructive()
						.onClick(async () => {
							const input = await askSettingsTransferInput(plugin.app);
							if (!input) return;
							try {
								const imported = await plugin.transfer.importFrom(input);
								if (!imported) return;
								notifyInfo("Settings imported.");
								ctx.rerender();
							} catch (err) {
								reportError(err);
							}
						}),
				);
			},
		},
	]);
}
