import { Setting } from "obsidian";

import type { PluginHost } from "@/plugin/host";
import {
	EFieldKind,
	EStorageBackend,
	type GoogleDriveStorageConfig,
	getDescriptor,
	googleLoginUrl,
	type SettingsFieldSpec,
} from "@/storage";
import { notifyError, notifyInfo } from "@/ui";

/**
 * Renders one backend's credential fields. Takes the kind explicitly so the shares section can edit S3
 * without the vault switching to it.
 */
export function renderStorageFields(
	parent: HTMLElement,
	plugin: PluginHost,
	kind: EStorageBackend,
): void {
	for (const field of getDescriptor(kind).fields) {
		renderStorageField(parent, plugin, kind, field);
	}
	if (kind === EStorageBackend.GoogleDrive) {
		renderGoogleDriveAuth(parent, plugin, kind);
	}
}

function storageOf(
	plugin: PluginHost,
	kind: EStorageBackend,
): Record<string, unknown> {
	const config =
		plugin.settings.storageConfigs[kind] ?? getDescriptor(kind).defaults();
	return config as unknown as Record<string, unknown>;
}

function renderStorageField(
	parent: HTMLElement,
	plugin: PluginHost,
	kind: EStorageBackend,
	field: SettingsFieldSpec,
): void {
	const setting = new Setting(parent).setName(field.name);
	if (field.desc) setting.setDesc(field.desc);
	const storage = storageOf(plugin, kind);

	if (field.kind === EFieldKind.Toggle) {
		setting.addToggle((t) =>
			t.setValue(Boolean(storage[field.key])).onChange((v) => {
				updateStorage(plugin, kind, { [field.key]: v });
			}),
		);
		return;
	}
	if (field.kind === EFieldKind.Number) {
		const numberField = field;
		setting.addText((t) => {
			t.inputEl.type = "number";
			t.inputEl.min = String(numberField.min);
			t.inputEl.max = String(numberField.max);
			const raw = storage[numberField.key];
			const value = typeof raw === "number" ? raw : numberField.fallback;
			t.setValue(String(value)).onChange((v) => {
				const parsed = Number.parseInt(v, 10);
				if (!Number.isFinite(parsed)) return;
				const next = Math.min(
					numberField.max,
					Math.max(numberField.min, parsed),
				);
				updateStorage(plugin, kind, { [numberField.key]: next });
			});
		});
		return;
	}
	setting.addText((t) => {
		const isSecret = field.kind === EFieldKind.Password;
		if (isSecret) t.inputEl.type = "password";
		if (field.placeholder) t.setPlaceholder(field.placeholder);
		const raw = storage[field.key];
		const text = typeof raw === "string" ? raw : "";
		t.setValue(text).onChange((v) => {
			// Trim non-secret fields only; trailing spaces in passwords must be preserved.
			updateStorage(plugin, kind, { [field.key]: isSecret ? v : v.trim() });
		});
	});
}

function renderGoogleDriveAuth(
	parent: HTMLElement,
	plugin: PluginHost,
	kind: EStorageBackend,
): void {
	// Read on click too: editing a field replaces the config object.
	const config = () =>
		storageOf(plugin, kind) as unknown as GoogleDriveStorageConfig;
	const isAuth = Boolean(config().refreshToken);

	new Setting(parent)
		.setName("Google account")
		.setDesc(
			isAuth
				? "Authenticated. Tokens are stored on this device."
				: "Not authenticated. Click to authorize.",
		)
		.addButton((b) =>
			b
				.setButtonText(isAuth ? "Re-authenticate" : "Log in")
				.setCta()
				.onClick(() => {
					if (!config().authServerUrl) {
						notifyInfo("Set the auth server URL first.");
						return;
					}
					window.open(googleLoginUrl(config()));
				}),
		);
}

function updateStorage(
	plugin: PluginHost,
	kind: EStorageBackend,
	patch: Record<string, unknown>,
): void {
	const settings = plugin.settings;
	settings.storageConfigs[kind] = {
		...(settings.storageConfigs[kind] ?? getDescriptor(kind).defaults()),
		...patch,
	};
	void plugin
		.saveSettings()
		.catch((err: unknown) => notifyError("Could not save settings", err));
}
