import { Setting } from "obsidian";

import { clearCachedPassphrase } from "@/crypto/passphrase-cache";
import type { PluginHost } from "@/plugin/host";
import { isStorageConfigured } from "@/settings/model";
import { PassphraseRotatedError } from "@/sync/keyfile";
import { askNewPassphrase, notifyError, notifyInfo, reportError } from "@/ui";

export function renderSecuritySection(
	parent: HTMLElement,
	plugin: PluginHost,
	onDisplay: () => void,
): void {
	new Setting(parent).setName("Encryption").setHeading();

	const status = plugin.passphrase.has()
		? "Loaded for this session."
		: "Not loaded for this session. Sync will use a saved passphrase or ask you for one.";

	new Setting(parent)
		.setName("Cache passphrase between launches")
		.setDesc(
			"Saves a verified passphrase on this device. Its encryption key is stored in the same plugin folder; disable on shared devices.",
		)
		.addToggle((t) =>
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

	new Setting(parent)
		.setName("Passphrase on this device")
		.setDesc(
			`${status} Enter does not change the vault passphrase. Forget clears it from this device, including the saved copy.`,
		)
		.addButton((b) =>
			b.setButtonText("Enter…").onClick(async () => {
				if (await plugin.passphrase.prompt(true)) onDisplay();
			}),
		)
		.addButton((b) =>
			b
				.setButtonText("Forget")
				.setDestructive()
				.onClick(async () => {
					await plugin.passphrase.forget();
					notifyInfo("Passphrase forgotten on this device.");
					onDisplay();
				}),
		);

	new Setting(parent)
		.setName("Change vault passphrase")
		.setDesc(
			"Set a new passphrase for this vault. Notes do not need to be uploaded again. Your other devices must enter the new passphrase.",
		)
		.addButton((button) =>
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
					onDisplay();
				}
			}),
		);
}
