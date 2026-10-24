import type { Setting, SettingDefinitionGroup } from "obsidian";

import {
	AUTO_PUSH_SETTLE_MAX_SECONDS,
	AUTO_PUSH_SETTLE_MIN_SECONDS,
	AUTO_SYNC_MAX_MINUTES,
	AUTO_SYNC_MIN_MINUTES,
	BULK_DELETE_LIMIT_MAX,
	BULK_DELETE_LIMIT_MIN,
	FILE_HISTORY_MAX_SNAPSHOTS,
	FILE_HISTORY_MIN_SNAPSHOTS,
} from "@/constants";
import type { RelayStatus } from "@/hub/status";
import type { PluginHost } from "@/plugin/host";
import type { People } from "@/presence";
import {
	type FieldContext,
	fieldRow,
	group,
	type SettingsField,
	SUB_SETTING_CLASS,
} from "@/settings/fields";
import { DEFAULT_SETTINGS, isRelayConfigured } from "@/settings/model";
import { EFieldKind } from "@/storage";
import { clampMaxSnapshots } from "@/sync/history";
import { VAULT_SPACE } from "@/sync/space";
import { RELAY_TEXT } from "@/ui/common";

const AUTOSYNC_FIELD: SettingsField = {
	kind: EFieldKind.Toggle,
	name: "Autosync",
	desc: "Sync automatically: once after startup and on a schedule. Pulls remote changes; conflicts that cannot be merged safely stop the cycle.",
	get: (s) => s.autoSyncEnabled,
	set: (v) => ({ autoSyncEnabled: v }),
	rerender: true,
};

const REALTIME_FIELD: SettingsField = {
	kind: EFieldKind.Toggle,
	name: "Real-time sync",
	desc: "Other devices pull the moment you push, and you see who is in which note. Turning it off also stops live editing. Your devices use the relay server (Connection tab), shared folders their owner's.",
	get: (s) => s.realtimeSync,
	set: (v) => ({ realtimeSync: v }),
	after: restartRelay,
	rerender: true,
};

const LIVE_EDITING_FIELD: SettingsField = {
	kind: EFieldKind.Toggle,
	name: "Live editing",
	desc: "Notes open in the editor edit together, keystroke by keystroke, across your devices and with the people in shared folders, through the relay.",
	when: (s) => s.realtimeSync,
	sub: true,
	get: (s) => s.liveEditing,
	set: (v) => ({ liveEditing: v }),
	after: (plugin) => void plugin.realtime.live.refresh(),
};

/** What the setup wizard offers once the vault syncs; real-time sync only with a relay to carry it. */
export const SETUP_FIELDS: ReadonlyArray<SettingsField> = [
	AUTOSYNC_FIELD,
	{ ...REALTIME_FIELD, when: isRelayConfigured },
	LIVE_EDITING_FIELD,
];

const AUTOMATION_FIELDS: ReadonlyArray<SettingsField> = [
	AUTOSYNC_FIELD,
	{
		kind: EFieldKind.Number,
		name: "Interval (minutes)",
		desc: `How often to sync. 0 means only once after startup. Max ${AUTO_SYNC_MAX_MINUTES}.`,
		when: (s) => s.autoSyncEnabled,
		sub: true,
		get: (s) => String(s.autoSyncIntervalMinutes),
		parse: (raw) =>
			clampInt(raw, AUTO_SYNC_MIN_MINUTES, AUTO_SYNC_MAX_MINUTES, 0),
		set: (v) => ({ autoSyncIntervalMinutes: v }),
	},
	{
		kind: EFieldKind.Toggle,
		name: "Push after successful pull",
		desc: "After a pull with no conflicts, also push local changes. Disable to only pull and review incoming changes.",
		when: (s) => s.autoSyncEnabled,
		sub: true,
		get: (s) => s.autoPushAfterSync,
		set: (v) => ({ autoPushAfterSync: v }),
	},
	{
		kind: EFieldKind.Toggle,
		name: "Push after changes settle",
		desc: "Queue changed files and push once the vault has been quiet for the delay below. Rapid saves are combined into one compare and push. Never pulls: conflicts and incoming changes are left untouched.",
		get: (s) => s.autoPushAfterChange,
		set: (v) => ({ autoPushAfterChange: v }),
		rerender: true,
	},
	{
		kind: EFieldKind.Slider,
		name: "Quiet period (seconds)",
		desc: `How long the vault must stay quiet after a change before the queued push runs (${AUTO_PUSH_SETTLE_MIN_SECONDS}–${AUTO_PUSH_SETTLE_MAX_SECONDS}). Shorter pushes sooner, longer batches more saves.`,
		when: (s) => s.autoPushAfterChange,
		sub: true,
		min: AUTO_PUSH_SETTLE_MIN_SECONDS,
		max: AUTO_PUSH_SETTLE_MAX_SECONDS,
		step: 1,
		get: (s) => s.autoPushSettleSeconds,
		set: (v) => ({ autoPushSettleSeconds: v }),
	},
	{
		kind: EFieldKind.Toggle,
		name: "Push only queued files",
		desc: "Push only files changed during the quiet period. Disable to also push other pending local changes.",
		when: (s) => s.autoPushAfterChange,
		sub: true,
		get: (s) => s.autoPushChangedFilesOnly,
		set: (v) => ({ autoPushChangedFilesOnly: v }),
	},
	{
		kind: EFieldKind.Toggle,
		name: "Ask before pushing many deletions",
		desc: "An automatic push holds back deleting more files than the limit below and asks you to review them first. Guards against storage that briefly hides a folder. Pushing by hand is not affected.",
		get: (s) => s.confirmBulkDeletes,
		set: (v) => ({ confirmBulkDeletes: v }),
		rerender: true,
	},
	{
		kind: EFieldKind.Number,
		name: "Deletion limit",
		desc: `How many deleted files an automatic push may publish without asking (${BULK_DELETE_LIMIT_MIN}-${BULK_DELETE_LIMIT_MAX}).`,
		when: (s) => s.confirmBulkDeletes,
		sub: true,
		get: (s) => String(s.bulkDeleteLimit),
		parse: (raw) =>
			clampInt(
				raw,
				BULK_DELETE_LIMIT_MIN,
				BULK_DELETE_LIMIT_MAX,
				DEFAULT_SETTINGS.bulkDeleteLimit,
			),
		set: (v) => ({ bulkDeleteLimit: v }),
	},
	{
		kind: EFieldKind.Toggle,
		name: "File version history",
		desc: "Keep past versions of files so you can view or restore them. Each push appends what it changed to one small encrypted log; old versions are pruned automatically.",
		get: (s) => s.fileHistoryEnabled,
		set: (v) => ({ fileHistoryEnabled: v }),
		rerender: true,
	},
	{
		kind: EFieldKind.Number,
		name: "Versions to keep",
		desc: `How many snapshots to retain (${FILE_HISTORY_MIN_SNAPSHOTS}–${FILE_HISTORY_MAX_SNAPSHOTS}). Older versions are garbage-collected.`,
		when: (s) => s.fileHistoryEnabled,
		sub: true,
		get: (s) => String(s.fileHistoryMaxSnapshots),
		parse: (raw) => clampMaxSnapshots(Number.parseInt(raw, 10)),
		set: (v) => ({ fileHistoryMaxSnapshots: v }),
	},
	{
		kind: EFieldKind.Toggle,
		name: "Auto-refresh history after push",
		desc: "Reload the open file-history view automatically when a push completes. Disable to refresh only via the ⟳ button.",
		when: (s) => s.fileHistoryEnabled,
		sub: true,
		get: (s) => s.historyAutoRefresh,
		set: (v) => ({ historyAutoRefresh: v }),
	},
	REALTIME_FIELD,
	LIVE_EDITING_FIELD,
	{
		kind: EFieldKind.Toggle,
		name: "Show my open note to others",
		desc: "Off, others see only that you are online. Live editing still shows you in a note you both have open.",
		when: (s) => s.realtimeSync,
		sub: true,
		get: (s) => s.showOpenNote,
		set: (v) => ({ showOpenNote: v }),
	},
];

export function automationSection(ctx: FieldContext): SettingDefinitionGroup {
	return group("Automation", [
		...AUTOMATION_FIELDS.map((field) => fieldRow(ctx, field)),
		{
			name: "Connected devices",
			visible: () => ctx.plugin.settings.realtimeSync,
			render: (setting) => renderConnectedDevices(setting, ctx.plugin),
		},
	]);
}

function renderConnectedDevices(
	devicesSetting: Setting,
	plugin: PluginHost,
): () => void {
	devicesSetting.settingEl.addClass(SUB_SETTING_CLASS);
	const { hub, people } = plugin.realtime;
	const render = (): void => {
		devicesSetting.setDesc(
			describeConnectedDevices(
				plugin.realtime.hub.statusOf(VAULT_SPACE.id),
				people.devices(),
			),
		);
	};
	render();

	const unsubscribeStatus = hub.listen({ onConnectionChange: render });
	const unsubscribeDevices = people.subscribe(render);
	return () => {
		unsubscribeStatus();
		unsubscribeDevices();
	};
}

function restartRelay(plugin: PluginHost): void {
	plugin.realtime.hub.restart();
}

function clampInt(
	raw: string,
	min: number,
	max: number,
	fallback: number,
): number {
	const parsed = Number.parseInt(raw, 10);
	return Math.max(
		min,
		Math.min(max, Number.isFinite(parsed) ? parsed : fallback),
	);
}

function describeConnectedDevices(
	status: RelayStatus,
	{ locked, devices }: ReturnType<People["devices"]>,
): string {
	if (status !== "connected") return RELAY_TEXT[status];
	if (locked) return "Sync once to unlock the device list.";
	if (devices.length === 0) {
		return "No other devices connected.";
	}
	return devices.map((device) => device.name).join(", ");
}
