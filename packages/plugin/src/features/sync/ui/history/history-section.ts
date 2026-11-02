import type { SettingDefinitionGroup } from "obsidian";
import { HISTORY_KEEP_MS, HISTORY_KEEP_TEXT } from "@/core/constants";
import {
	bind,
	EFieldKind,
	type FieldContext,
	fieldRow,
	group,
	type HistoryKeep,
	type SettingsField,
	type SettingsHost,
	type SettingsRow,
	SUB_SETTING_CLASS,
} from "@/core/settings";
import { closePluginSettings } from "@/core/ui";
import type { SnapshotListResult } from "../../history/types";
import type { HistorySectionHost } from "../../host";
import { renderHistoryHolds } from "./holds-row";

const KEEP_HISTORY_FIELD: SettingsField<HistorySectionHost> = {
	kind: EFieldKind.Choice,
	name: "Keep history for",
	desc: "Every push stays for an hour, then one version per 10 minutes, hour, day and week; past this only how busy each day was remains. Pinned versions stay. Each device thins the same history, so the shortest choice among them applies.",
	when: (s) => s.fileHistoryEnabled,
	sub: true,
	options: HISTORY_KEEP_TEXT,
	get: (s) => s.fileHistoryKeep,
	set: (v) => ({ fileHistoryKeep: v as HistoryKeep }),
	after: (plugin) => plugin.refreshSourceControlView(true),
	// The ladder below it follows the choice.
	rerender: true,
};

const HISTORY_FIELDS: ReadonlyArray<SettingsField<HistorySectionHost>> = [
	{
		kind: EFieldKind.Toggle,
		name: "Keep history",
		desc: "Keep past versions of files so you can view or restore them. Each push stores what it changed as a small encrypted record; old versions thin out automatically.",
		...bind("fileHistoryEnabled"),
		rerender: true,
	},
	KEEP_HISTORY_FIELD,
	{
		kind: EFieldKind.Toggle,
		name: "Show activity in Timeline",
		desc: "A calendar of pushes per day above the Timeline; select a day to jump to it.",
		when: (s) => s.fileHistoryEnabled,
		sub: true,
		...bind("fileHistoryActivity"),
		after: (plugin) => plugin.refreshSourceControlView(),
	},
	{
		kind: EFieldKind.Toggle,
		name: "Auto-refresh history after push",
		desc: "Reload the open file-history view automatically when a push completes. Disable to refresh only via the ⟳ button.",
		when: (s) => s.fileHistoryEnabled,
		sub: true,
		...bind("historyAutoRefresh"),
	},
];

/** What the History page's row says beside its name. */
export function historyValue(plugin: SettingsHost): string {
	const { fileHistoryEnabled, fileHistoryKeep } = plugin.settings;
	return fileHistoryEnabled ? HISTORY_KEEP_TEXT[fileHistoryKeep] : "Off";
}

export function historySection(
	ctx: FieldContext<HistorySectionHost>,
	loadHistory: () => Promise<SnapshotListResult>,
): SettingDefinitionGroup {
	const rows = HISTORY_FIELDS.map((field) => fieldRow(ctx, field));
	const keep = HISTORY_FIELDS.indexOf(KEEP_HISTORY_FIELD) + 1;
	return group(undefined, [
		...rows.slice(0, keep),
		historyHoldsRow(ctx.plugin, loadHistory),
		...rows.slice(keep),
	]);
}

function historyHoldsRow(
	plugin: HistorySectionHost,
	loadHistory: () => Promise<SnapshotListResult>,
): SettingsRow {
	return {
		name: "What history holds",
		desc: "Pushes per day across your devices. Faded days keep counts only. Select a day to open it in Timeline.",
		visible: () => plugin.settings.fileHistoryEnabled,
		render: (setting) => {
			setting.settingEl.addClass(SUB_SETTING_CLASS);
			renderHistoryHolds(setting, {
				load: loadHistory,
				horizon: HISTORY_KEEP_MS[plugin.settings.fileHistoryKeep],
				onPick: (day) => {
					closePluginSettings(plugin.app);
					void plugin.openTimeline(day.start);
				},
			});
		},
	};
}
