import type { SettingDefinitionGroup } from "obsidian";
import {
	AUTO_PUSH_SETTLE_MAX_SECONDS,
	AUTO_PUSH_SETTLE_MIN_SECONDS,
	BULK_DELETE_LIMIT_MAX,
	BULK_DELETE_LIMIT_MIN,
	SLOW_FILE_SETTLE_MAX_SECONDS,
	SLOW_FILE_SETTLE_MIN_SECONDS,
} from "@/core/constants";
import {
	bind,
	DEFAULT_CORE_SETTINGS,
	EFieldKind,
	type FieldContext,
	fieldRow,
	group,
	type SettingsField,
	type SettingsHost,
} from "@/core/settings";
import { pluralize } from "@/core/shared";

const INTERVAL_CHOICES: Readonly<Record<number, string>> = {
	0: "Only at startup",
	5: "Every 5 minutes",
	15: "Every 15 minutes",
	30: "Every 30 minutes",
	60: "Every hour",
	240: "Every 4 hours",
};

const AUTOSYNC_FIELD: SettingsField<SettingsHost> = {
	kind: EFieldKind.Toggle,
	name: "Autosync",
	desc: "Sync automatically: once after startup and on a schedule. Pulls remote changes; conflicts that cannot be merged safely stop the cycle.",
	...bind("autoSyncEnabled"),
	rerender: true,
};

const AUTOMATION_FIELDS: ReadonlyArray<SettingsField<SettingsHost>> = [
	AUTOSYNC_FIELD,
	{
		kind: EFieldKind.Choice,
		name: "Interval",
		desc: "How often to sync after the sync at startup.",
		when: (s) => s.autoSyncEnabled,
		sub: true,
		options: (s) => intervalChoices(s.autoSyncIntervalMinutes),
		get: (s) => String(s.autoSyncIntervalMinutes),
		set: (v) => ({ autoSyncIntervalMinutes: Number(v) }),
	},
	{
		kind: EFieldKind.Toggle,
		name: "Push after successful pull",
		desc: "After a pull with no conflicts, also push local changes. Disable to only pull and review incoming changes.",
		when: (s) => s.autoSyncEnabled,
		sub: true,
		...bind("autoPushAfterSync"),
	},
	{
		kind: EFieldKind.Toggle,
		name: "Push after changes settle",
		desc: "Queue changed files and push once the vault has been quiet for the delay below. Rapid saves are combined into one compare and push. Never pulls: conflicts and incoming changes are left untouched.",
		...bind("autoPushAfterChange"),
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
		...bind("autoPushSettleSeconds"),
	},
	{
		kind: EFieldKind.Toggle,
		name: "Push only queued files",
		desc: "Push only files changed during the quiet period. Disable to also push other pending local changes.",
		when: (s) => s.autoPushAfterChange,
		sub: true,
		...bind("autoPushChangedFilesOnly"),
	},
	{
		kind: EFieldKind.Text,
		name: "Slow files",
		desc: "Files ending with these, separated by commas, save every few seconds while you work on them. A push after changes waits until you stop or leave the file, at most 10 minutes. Excalidraw drawings count as .excalidraw.md whatever their name. Pushing by hand sends them at once.",
		placeholder: ".excalidraw.md, .canvas",
		...bind("slowFileSuffixes"),
	},
	{
		kind: EFieldKind.Slider,
		name: "Slow files quiet period (seconds)",
		desc: `How long a slow file must stay unchanged before an automatic push takes it (${SLOW_FILE_SETTLE_MIN_SECONDS}-${SLOW_FILE_SETTLE_MAX_SECONDS}).`,
		sub: true,
		min: SLOW_FILE_SETTLE_MIN_SECONDS,
		max: SLOW_FILE_SETTLE_MAX_SECONDS,
		step: 5,
		...bind("slowFileSettleSeconds"),
	},
	{
		kind: EFieldKind.Toggle,
		name: "Ask before pushing many deletions",
		desc: "An automatic push holds back deleting more files than the limit below and asks you to review them first. Guards against storage that briefly hides a folder. Pushing by hand is not affected.",
		...bind("confirmBulkDeletes"),
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
				DEFAULT_CORE_SETTINGS.bulkDeleteLimit,
			),
		set: (v) => ({ bulkDeleteLimit: v }),
	},
];

export function automationSection(
	ctx: FieldContext<SettingsHost>,
): SettingDefinitionGroup {
	return group(
		"Automatic sync",
		AUTOMATION_FIELDS.map((field) => fieldRow(ctx, field)),
	);
}

/** A value from an older version or a setup link stays choosable as it is. */
function intervalChoices(current: number): Record<number, string> {
	if (current in INTERVAL_CHOICES) return { ...INTERVAL_CHOICES };
	return {
		...INTERVAL_CHOICES,
		[current]: `Every ${pluralize(current, "minute")}`,
	};
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
