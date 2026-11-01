import type { Setting, SettingDefinitionGroup } from "obsidian";
import {
	EFieldKind,
	EPluginLevel,
	type FieldContext,
	fieldRow,
	group,
	introRow,
	type MdsyncSettings,
	type SettingsRow,
	type SettingsSyncCategories,
	SUB_SETTING_CLASS,
} from "@/core/settings";
import {
	notifyError,
	notifyInfo,
	openConfirmModal,
	renderSegments,
} from "@/core/ui";
import type { SyncHost } from "../host";
import type { Manifest } from "../types";
import {
	listPlugins,
	PLUGIN_LEVEL_OPTIONS,
	PluginLevelsModal,
} from "./plugin-levels-modal";
import {
	createScopePolicy,
	defaultPluginLevel,
	type ScopePolicy,
} from "./scope";

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
		name: "Plugins",
		desc: "Settings: each plugin's data.json. Code: also the plugin itself, so it installs and updates everywhere. All: also the rest of its folder, such as caches. MDSync and device-local plugins never sync.",
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
	ctx: FieldContext<SyncHost>,
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
		...SETTINGS_SYNC_ROWS.flatMap((row) =>
			row.key === "pluginConfigs"
				? [pluginsRow(ctx, row, true), perPluginRow(ctx)]
				: [categoryRow(ctx, row)],
		),
	]);
}

/** The Plugins level and Per plugin rows for the setup wizard, which offers no Clear on remote. */
export function pluginLevelRows(ctx: FieldContext<SyncHost>): SettingsRow[] {
	const row = SETTINGS_SYNC_ROWS.find(({ key }) => key === "pluginConfigs");
	return row ? [pluginsRow(ctx, row, false), perPluginRow(ctx)] : [];
}

function categoryRow(
	ctx: FieldContext<SyncHost>,
	row: SettingsSyncRow,
): SettingsRow {
	const { plugin } = ctx;
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
			addClearButton(ctx, row, setting);
		},
	};
}

/** Off turns the category off and keeps the level for when it is back on. */
function pluginsRow(
	ctx: FieldContext<SyncHost>,
	row: SettingsSyncRow,
	clear: boolean,
): SettingsRow {
	const { plugin } = ctx;
	return {
		name: row.name,
		desc: row.desc,
		render: (setting) => {
			setting.setClass("mdsync-stacked-setting");
			renderSegments(
				setting.controlEl,
				"plugin-level",
				PLUGIN_LEVEL_OPTIONS,
				() =>
					defaultPluginLevel(
						plugin.settings.settingsSync,
						plugin.settings.pluginLevel,
					),
				async (level) => {
					const { settingsSync, pluginLevel, pluginLevels } = plugin.settings;
					await saveScope(ctx, {
						settingsSync: {
							...settingsSync,
							pluginConfigs: level !== EPluginLevel.Off,
						},
						pluginLevel: level === EPluginLevel.Off ? pluginLevel : level,
						// One equal to the new default would stay pinned there unseen.
						pluginLevels: Object.fromEntries(
							Object.entries(pluginLevels).filter(([, own]) => own !== level),
						),
					});
					ctx.rerender();
				},
			).el.addClasses(["is-compact", "mdsync-plugin-level"]);
			if (clear) addClearButton(ctx, row, setting);
		},
	};
}

function perPluginRow(ctx: FieldContext<SyncHost>): SettingsRow {
	const { plugin } = ctx;
	return {
		name: "Per plugin",
		desc: "Give single plugins a level of their own.",
		render: (setting) => {
			setting.settingEl.addClass(SUB_SETTING_CLASS);
			const own = Object.keys(plugin.settings.pluginLevels).length;
			if (own > 0) {
				setting.setDesc(`${own} plugin(s) have a level of their own.`);
			}
			setting.addButton((button) =>
				button.setButtonText("Choose").onClick(() => void choosePerPlugin(ctx)),
			);
		},
	};
}

async function choosePerPlugin(ctx: FieldContext<SyncHost>): Promise<void> {
	const { plugin } = ctx;
	const { adapter, configDir } = plugin.app.vault;
	const remote = plugin.controller.getSnapshot().result?.remote ?? null;
	const plugins = await listPlugins(
		adapter,
		createScopePolicy({
			settingsSync: plugin.settings.settingsSync,
			configDir,
		}),
		configDir,
		remote,
	);
	// Read after the listing: the default may have changed meanwhile.
	const { settingsSync, pluginLevel } = plugin.settings;
	new PluginLevelsModal(plugin.app, {
		plugins,
		remoteKnown: remote !== null,
		defaultLevel: defaultPluginLevel(settingsSync, pluginLevel),
		levels: () => plugin.settings.pluginLevels,
		save: (pluginLevels) => saveScope(ctx, { pluginLevels }),
		onClose: () => ctx.rerender(),
	}).open();
}

async function saveScope(
	ctx: FieldContext<SyncHost>,
	patch: Partial<MdsyncSettings>,
): Promise<void> {
	Object.assign(ctx.plugin.settings, patch);
	await ctx.plugin.saveSettings();
	ctx.plugin.scheduleScopeRefresh("Sync scope settings changed.");
}

function addClearButton(
	ctx: FieldContext<SyncHost>,
	row: SettingsSyncRow,
	setting: Setting,
): void {
	const { plugin } = ctx;
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
}

async function clearCategory(
	ctx: FieldContext<SyncHost>,
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
