import type { Setting } from "obsidian";

import type { PluginHost } from "@/app/host";
import { onSettled, type SettingsRow } from "@/core/settings";
import { notifyError, notifyInfo } from "@/core/ui";
import { googleLoginUrl } from "../backends/google-drive-auth";
import { EStorageBackend, type GoogleDriveStorageConfig } from "../config";
import { EFieldKind, type SettingsFieldSpec } from "../field-spec";
import { getDescriptor } from "../registry";

export function storageRows(
	plugin: PluginHost,
	kind: EStorageBackend,
): SettingsRow[] {
	const rows: SettingsRow[] = getDescriptor(kind).fields.map((field) => ({
		name: field.name,
		desc: field.desc,
		render: (setting) => renderStorageField(setting, plugin, kind, field),
	}));
	if (kind === EStorageBackend.GoogleDrive) {
		rows.push({
			name: "Google account",
			render: (setting) => renderGoogleDriveAuth(setting, plugin, kind),
		});
	}
	return rows;
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
	setting: Setting,
	plugin: PluginHost,
	kind: EStorageBackend,
	field: SettingsFieldSpec,
): void {
	const storage = storageOf(plugin, kind);
	// An identity field changes the hub route key: save once typing settles, not per key.
	const saveTyped = onSettled(() => saveSettings(plugin));

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
				updateStorage(plugin, kind, { [numberField.key]: next }, saveTyped);
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
			updateStorage(
				plugin,
				kind,
				{ [field.key]: isSecret ? v : v.trim() },
				saveTyped,
			);
		});
	});
}

function renderGoogleDriveAuth(
	setting: Setting,
	plugin: PluginHost,
	kind: EStorageBackend,
): void {
	// Read on click too: editing a field replaces the config object.
	const config = () =>
		storageOf(plugin, kind) as unknown as GoogleDriveStorageConfig;
	const isAuth = Boolean(config().refreshToken);

	setting
		.setDesc(
			isAuth
				? "Authenticated. Tokens are stored on this device."
				: createFragment((f) => {
						f.appendText("Not authenticated. Select ");
						f.createEl("strong", { text: "Log in" });
						f.appendText(" to authorize.");
					}),
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
	save: () => void = () => saveSettings(plugin),
): void {
	const settings = plugin.settings;
	settings.storageConfigs[kind] = {
		...(settings.storageConfigs[kind] ?? getDescriptor(kind).defaults()),
		...patch,
	};
	save();
}

function saveSettings(plugin: PluginHost): void {
	void plugin
		.saveSettings()
		.catch((err: unknown) => notifyError("Could not save settings", err));
}
