import type { SettingDefinitionGroup } from "obsidian";

import { clearCachedPassphrase } from "@/core/crypto";
import { type FieldContext, group, isStorageConfigured } from "@/core/settings";
import {
	askNewPassphrase,
	notifyError,
	notifyInfo,
	reportError,
} from "@/core/ui";
import { PassphraseRotatedError } from "@/features/sync";

export function securitySection(ctx: FieldContext): SettingDefinitionGroup {
	const { plugin, rerender } = ctx;
	return group("Encryption", [
		{
			name: "Cache passphrase between launches",
			desc: "Saves a verified passphrase on this device, encrypted with a key kept in Obsidian's keychain, outside the vault. Disable on shared devices.",
			render: (setting) => {
				setting.addToggle((t) =>
					t.setValue(plugin.settings.cachePassphrase).onChange(async (v) => {
						Object.assign(plugin.settings, { cachePassphrase: v });
						await plugin.saveSettings();
						if (v) {
							await plugin.passphrase.persistIfEnabled();
							return;
						}
						await clearCachedPassphrase(
							plugin.app.vault.adapter,
							plugin.app.vault.configDir,
						);
					}),
				);
			},
		},
		{
			name: "Passphrase on this device",
			render: (setting) => {
				const status = plugin.passphrase.has()
					? "Loaded for this session."
					: "Not loaded for this session. Sync will use a saved passphrase or ask you for one.";
				setting
					.setDesc(
						`${status} Enter does not change the vault passphrase. Forget clears it from this device, including the saved copy.`,
					)
					.addButton((b) =>
						b.setButtonText("Enter…").onClick(async () => {
							if (await plugin.passphrase.prompt(true)) rerender();
						}),
					)
					.addButton((b) =>
						b
							.setButtonText("Forget")
							.setDestructive()
							.onClick(async () => {
								await plugin.passphrase.forget();
								notifyInfo("Passphrase forgotten on this device.");
								rerender();
							}),
					);
			},
		},
		{
			name: "Change vault passphrase",
			desc: "Set a new passphrase for this vault. Notes do not need to be uploaded again. Your other devices must enter the new passphrase.",
			render: (setting) => {
				setting.addButton((button) =>
					button.setButtonText("Change…").onClick(async () => {
						if (!isStorageConfigured(plugin.settings)) {
							notifyInfo("Configure a storage backend first.");
							return;
						}
						button.setDisabled(true);
						try {
							if (!(await plugin.passphrase.prompt(false))) return;
							const next = await askNewPassphrase(plugin.app);
							if (!next) return;
							const epoch = await plugin.passphrase.rotate(next);
							if (epoch === null) return;
							notifyInfo(
								"Vault passphrase changed. Enter it on your other devices.",
							);
						} catch (err) {
							if (err instanceof PassphraseRotatedError) {
								notifyError("Current passphrase is incorrect.");
								return;
							}
							reportError(err);
						} finally {
							button.setDisabled(false);
							rerender();
						}
					}),
				);
			},
		},
	]);
}
