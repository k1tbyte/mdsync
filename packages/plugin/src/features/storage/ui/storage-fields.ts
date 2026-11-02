import type { Setting } from "obsidian";
import {
	EFieldKind,
	type FieldContext,
	fieldRow,
	type MdsyncSettings,
	type SettingsField,
	type SettingsRow,
} from "@/core/settings";
import { notifyInfo } from "@/core/ui";
import { googleLoginUrl } from "../backends/google-drive-auth";
import {
	EStorageBackend,
	type GoogleDriveStorageConfig,
	type StorageAdapterConfig,
} from "../config";
import type { SettingsFieldSpec } from "../field-spec";
import type { StorageHost } from "../host";
import { getDescriptor } from "../registry";

export function storageRows(
	ctx: FieldContext<StorageHost>,
	kind: EStorageBackend,
): SettingsRow[] {
	const rows: SettingsRow[] = getDescriptor(kind).fields.map((spec) =>
		fieldRow(ctx, storageField(kind, spec)),
	);
	if (kind === EStorageBackend.GoogleDrive) {
		rows.push({
			name: "Google account",
			render: (setting) => renderGoogleDriveAuth(setting, ctx.plugin, kind),
		});
	}
	return rows;
}

function configOf(
	settings: MdsyncSettings,
	kind: EStorageBackend,
): Record<string, unknown> {
	const config =
		settings.storageConfigs[kind] ?? getDescriptor(kind).defaults();
	return config as unknown as Record<string, unknown>;
}

/** Patches a fresh config: another field may have replaced it since this row drew. */
function patchConfig(
	plugin: StorageHost,
	kind: EStorageBackend,
	key: string,
	value: unknown,
): Partial<MdsyncSettings> {
	const next = { ...configOf(plugin.settings, kind), [key]: value };
	return {
		storageConfigs: {
			...plugin.settings.storageConfigs,
			[kind]: next as unknown as StorageAdapterConfig,
		},
	};
}

function storageField(
	kind: EStorageBackend,
	spec: SettingsFieldSpec,
): SettingsField<StorageHost> {
	const { key, name, desc } = spec;
	const set = (value: unknown, plugin: StorageHost) =>
		patchConfig(plugin, kind, key, value);
	const text = (settings: MdsyncSettings): string => {
		const raw = configOf(settings, kind)[key];
		return typeof raw === "string" ? raw : "";
	};

	switch (spec.kind) {
		case EFieldKind.Toggle:
			return {
				kind: EFieldKind.Toggle,
				name,
				desc,
				get: (s) => Boolean(configOf(s, kind)[key]),
				set,
			};
		case EFieldKind.Number:
			return {
				kind: EFieldKind.Number,
				name,
				desc,
				min: spec.min,
				max: spec.max,
				get: (s) => {
					const raw = configOf(s, kind)[key];
					return String(typeof raw === "number" ? raw : spec.fallback);
				},
				parse: (raw) =>
					Math.min(spec.max, Math.max(spec.min, Number.parseInt(raw, 10))),
				set,
			};
		case EFieldKind.Password:
			// Trailing spaces in a password are part of it.
			return {
				kind: EFieldKind.Password,
				name,
				desc,
				placeholder: spec.placeholder,
				get: text,
				set,
			};
		case EFieldKind.Text:
			return {
				kind: EFieldKind.Text,
				name,
				desc,
				placeholder: spec.placeholder,
				get: text,
				set: (value, plugin) => set(value.trim(), plugin),
			};
	}
}

function renderGoogleDriveAuth(
	setting: Setting,
	plugin: StorageHost,
	kind: EStorageBackend,
): void {
	// Read on click too: editing a field replaces the config object.
	const config = () =>
		configOf(plugin.settings, kind) as unknown as GoogleDriveStorageConfig;
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
