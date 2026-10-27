import type { SettingDefinitionGroup } from "obsidian";
import type { SettingsSyncCategories } from "@/core/settings";
import {
	EFieldKind,
	type FieldContext,
	fieldRow,
	group,
	introRow,
	type SettingsRow,
} from "@/core/settings";
import { notifyError, notifyInfo, openConfirmModal } from "@/core/ui";
import type { Manifest } from "../types";
import { createScopePolicy, type ScopePolicy } from "./scope";

interface SettingsSyncRow {
	key: keyof SettingsSyncCategories;
	name: string;
	desc: string;
}

const SETTINGS_SYNC_ROWS: ReadonlyArray<SettingsSyncRow> = [
	{
		key: "coreSettings",
		name: "Core settings",
		desc: "App, appearance, core plugins, graph, bookmarks and templates.",
	},
	{ key: "hotkeys", name: "Hotkeys", desc: "hotkeys.json" },
	{
		key: "pluginList",
		name: "Enabled community plugins",
		desc: "community-plugins.json only",
	},
	{
		key: "pluginConfigs",
		name: "Plugins and their settings",
		desc: "Plugin files and settings (MDSync and device-local plugins excluded).",
	},
	{
		key: "snippets",
		name: "CSS snippets",
		desc: "snippets folder inside the config folder",
	},
	{
		key: "themes",
		name: "Themes",
		desc: "themes folder inside the config folder",
	},
];

function countRemoteCategories(
	remote: Manifest | null | undefined,
	scope: ScopePolicy,
): Map<keyof SettingsSyncCategories, number> {
	const counts = new Map<keyof SettingsSyncCategories, number>();
	const paths = [
		...Object.keys(remote?.files ?? {}),
		...(remote?.folders ?? []).map((dir) => `${dir}/`),
	];
	for (const path of paths) {
		const category = scope.getCategory(path);
		if (category) counts.set(category, (counts.get(category) ?? 0) + 1);
	}
	return counts;
}

export function configurationScopeSection(
	ctx: FieldContext,
): SettingDefinitionGroup {
	const { plugin } = ctx;
	return group("Obsidian configuration scope", [
		introRow(
			"Workspace, cache, trash and device-local plugin data are never synced. Turning a category off only stops this device from syncing it; the remote keeps its files.",
		),
		{
			...introRow("Compare with the remote to see which categories it holds."),
			visible: () => !plugin.controller.getSnapshot().result?.remote,
			render: (setting) => {
				setting.setName("").addButton((button) =>
					button.setButtonText("Check remote").onClick(async () => {
						button.setDisabled(true);
						await plugin.controller.refresh();
						ctx.rerender();
					}),
				);
			},
		},
		...SETTINGS_SYNC_ROWS.map((row): SettingsRow => {
			const field = fieldRow(ctx, {
				kind: EFieldKind.Toggle,
				name: row.name,
				desc: row.desc,
				get: (s) => s.settingsSync[row.key],
				set: (v) => ({
					settingsSync: { ...plugin.settings.settingsSync, [row.key]: v },
				}),
				refreshScope: true,
			});
			return {
				...field,
				render: (setting) => {
					field.render(setting);
					const counts = countRemoteCategories(
						plugin.controller.getSnapshot().result?.remote,
						createScopePolicy({
							settingsSync: plugin.settings.settingsSync,
							configDir: plugin.app.vault.configDir,
						}),
					);
					const count = counts.get(row.key);
					if (!count) return;
					setting.addButton((button) =>
						button
							.setButtonText("Clear on remote")
							.setTooltip(`${count} remote item(s)`)
							.setDestructive()
							.onClick(() => void clearCategory(ctx, row)),
					);
				},
			};
		}),
	]);
}

async function clearCategory(
	ctx: FieldContext,
	row: SettingsSyncRow,
): Promise<void> {
	const { plugin } = ctx;
	const confirmed = await openConfirmModal({
		app: plugin.app,
		title: `Clear ${row.name} on remote?`,
		body: [
			`Removes every ${row.name} file from the remote storage. Local files stay on every device, and devices with this category enabled re-upload theirs on their next push.`,
			"Disable the category on every device first if it should stay gone. Update MDSync on your other devices before clearing: older versions refuse the cleared remote.",
		],
		confirmLabel: "Clear on remote",
		confirmClass: "mod-warning",
	});
	if (!confirmed) return;
	if (await plugin.controller.resetCategory(row.key)) {
		notifyInfo(`Cleared ${row.name} on remote.`);
	} else {
		notifyError(
			plugin.controller.getSnapshot().error ??
				"Could not clear the category on the remote.",
		);
	}
	ctx.rerender();
}
