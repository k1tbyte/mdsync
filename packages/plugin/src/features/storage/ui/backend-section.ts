import type { SettingDefinitionGroup } from "obsidian";

import { STORAGE_CHANGED_REASON } from "@/core/constants";
import { checkRow, type FieldContext, group, introRow } from "@/core/settings";
import type { EStorageBackend } from "../config";
import { getDescriptor, listBackends } from "../registry";
import { testConnection } from "./connection-test";
import { storageRows } from "./storage-fields";

export function backendSection(ctx: FieldContext): SettingDefinitionGroup {
	const { plugin } = ctx;
	return group("Backend", [
		introRow(
			"Credentials are stored on this device, encrypted with a key in Obsidian's keychain; a copy of the vault does not carry them. Inviting someone to a shared folder hands them to the relay, which signs that folder's requests.",
		),
		{
			name: "Storage backend",
			desc: "Select the remote that holds the encrypted manifest and objects.",
			render: (setting) => {
				setting.addDropdown((dropdown) => {
					const settings = plugin.settings;
					for (const entry of listBackends()) {
						dropdown.addOption(entry.kind, entry.label);
					}
					dropdown.setValue(settings.activeStorageKind);
					dropdown.onChange((value) => {
						const nextKind = value as EStorageBackend;
						if (nextKind === settings.activeStorageKind) return;

						// Keep saved config per backend; switch active pointer and seed defaults on first use.
						if (!settings.storageConfigs[nextKind]) {
							settings.storageConfigs[nextKind] =
								getDescriptor(nextKind).defaults();
						}
						settings.activeStorageKind = nextKind;

						void plugin.saveSettings().then(() => {
							plugin.scheduleScopeRefresh(STORAGE_CHANGED_REASON);
							ctx.rerender();
						});
					});
				});
			},
		},
		...listBackends().flatMap(({ kind }) =>
			storageRows(plugin, kind).map((row) => ({
				...row,
				visible: () => plugin.settings.activeStorageKind === kind,
			})),
		),
		checkRow(
			"Test connection",
			"Checks the credentials above by reading from the remote.",
			() => testConnection(plugin),
		),
	]);
}
