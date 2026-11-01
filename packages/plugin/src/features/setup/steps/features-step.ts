import { HISTORY_KEEP_TEXT } from "@/core/constants";
import {
	EFieldKind,
	fieldRow,
	type HistoryKeep,
	isRelayConfigured,
	type MdsyncSettings,
	renderDefinitions,
	type SettingsField,
} from "@/core/settings";
import { pluralize } from "@/core/shared";
import { callout, renderSegments } from "@/core/ui";
import { SETUP_FIELDS } from "@/features/settings";
import { pluginLevelRows } from "@/features/sync";
import { ESyncMode, syncModeOf, syncModePatch } from "../feature-choices";
import type { SetupHost } from "../host";
import { ESetupPath } from "../step-state";
import type { StepView, Wizard } from "../wizard";

const MODES = [
	{ value: ESyncMode.Manual, text: "Manual" },
	{ value: ESyncMode.Automatic, text: "Automatic" },
	{ value: ESyncMode.Instant, text: "Instant" },
];

const WITHOUT_RELAY =
	"Live editing, shared folders and share links need a relay, a small server in your own Cloudflare account. The next step sets one up; you can skip it.";

const HISTORY_FIELDS: ReadonlyArray<SettingsField<SetupHost>> = [
	{
		kind: EFieldKind.Toggle,
		name: "Keep history",
		desc: "Past versions of every file, deleted files and a timeline of each push, encrypted. Without it a file deleted on any device cannot be brought back.",
		get: (s) => s.fileHistoryEnabled,
		set: (v) => ({ fileHistoryEnabled: v }),
		rerender: true,
	},
	{
		kind: EFieldKind.Choice,
		name: "Keep for",
		desc: "Your devices share one history, so the shortest choice among them applies.",
		when: (s) => s.fileHistoryEnabled,
		sub: true,
		options: HISTORY_KEEP_TEXT,
		get: (s) => s.fileHistoryKeep,
		set: (v) => ({ fileHistoryKeep: v as HistoryKeep }),
	},
];

const CONFIG_FIELDS: ReadonlyArray<SettingsField<SetupHost>> = [
	{
		kind: EFieldKind.Toggle,
		name: "Core settings",
		desc: "App, appearance, core plugins, bookmarks and templates.",
		get: (s) => s.settingsSync.coreSettings,
		set: (v, plugin) => ({
			settingsSync: { ...plugin.settings.settingsSync, coreSettings: v },
		}),
		refreshScope: true,
	},
	{
		kind: EFieldKind.Toggle,
		name: "Hotkeys",
		desc: "Your keyboard shortcuts.",
		get: (s) => s.settingsSync.hotkeys,
		set: (v, plugin) => ({
			settingsSync: { ...plugin.settings.settingsSync, hotkeys: v },
		}),
		refreshScope: true,
	},
	{
		kind: EFieldKind.Toggle,
		name: "Themes and snippets",
		desc: "Installed themes and CSS snippets.",
		get: (s) => s.settingsSync.themes && s.settingsSync.snippets,
		set: (v, plugin) => ({
			settingsSync: {
				...plugin.settings.settingsSync,
				themes: v,
				snippets: v,
			},
		}),
		refreshScope: true,
	},
	{
		kind: EFieldKind.Toggle,
		name: "Enabled plugins",
		desc: "Which community plugins are switched on. Without it a plugin whose code syncs arrives switched off.",
		get: (s) => s.settingsSync.pluginList,
		set: (v, plugin) => ({
			settingsSync: { ...plugin.settings.settingsSync, pluginList: v },
		}),
		refreshScope: true,
	},
];

export function createFeaturesStep(wizard: Wizard): StepView {
	const { plugin } = wizard;
	// Instant without a relay is a wish until the relay step: real-time sync turns on once one answers.
	let wantsInstant = false;
	const ctx = { plugin, rerender: () => wizard.redraw() };

	const shownMode = (): ESyncMode =>
		wantsInstant && !isRelayConfigured(plugin.settings)
			? ESyncMode.Instant
			: syncModeOf(plugin.settings);

	const save = async (patch: Partial<MdsyncSettings>): Promise<void> => {
		const realtime = plugin.settings.realtimeSync;
		Object.assign(plugin.settings, patch);
		await plugin.saveSettings();
		if (plugin.settings.realtimeSync !== realtime) {
			plugin.realtime.hub.restart();
		}
		wizard.redraw();
	};

	const heading = (el: HTMLElement, name: string): void => {
		el.createEl("h4", { cls: "mdsync-setup-heading", text: name });
	};

	const renderMode = (el: HTMLElement): void => {
		heading(el, "When to sync");
		const box = el.createDiv({ cls: "mdsync-setup-choice" });
		renderSegments(box, "mdsync-sync-mode", MODES, shownMode, (mode) => {
			wantsInstant = mode === ESyncMode.Instant;
			return save(syncModePatch(plugin.settings, mode));
		});
		box.createDiv({
			cls: "mdsync-setup-choice-desc",
			text: modeText(plugin.settings, shownMode()),
		});
	};

	const renderConfig = (el: HTMLElement): void => {
		heading(el, "Obsidian settings and plugins");
		el.createDiv({
			cls: "mdsync-setup-note",
			text: "Chosen per device: a phone often keeps its own hotkeys and theme. Turning one off here deletes nothing.",
		});
		renderDefinitions(
			el,
			CONFIG_FIELDS.map((field) => fieldRow(ctx, field)),
		);
		renderDefinitions(el, pluginLevelRows(ctx));
	};

	const renderTogether = (el: HTMLElement): void => {
		heading(el, "Work with others");
		if (!isRelayConfigured(plugin.settings)) {
			el.createDiv({ cls: "mdsync-setup-note", text: WITHOUT_RELAY });
			return;
		}
		if (!plugin.settings.realtimeSync) {
			el.createDiv({
				cls: "mdsync-setup-note",
				text: "Live editing and showing others which note you have open come with Instant.",
			});
			return;
		}
		renderDefinitions(
			el,
			SETUP_FIELDS.map((field) => fieldRow(ctx, field)),
		);
	};

	const view: StepView = {
		render(el) {
			el.createEl("h3", { text: "Choose how MDSync works" });
			el.createEl("p", {
				cls: "mdsync-setup-lead",
				text: "Pick what you need now. You can change any of it later in Settings → MDSync.",
			});
			if (wizard.currentPath() === ESetupPath.Join) {
				callout(
					el,
					"info",
					"These came with the setup link. Change anything for this device; your other device keeps its own.",
				);
			}
			renderMode(el);
			heading(el, "History");
			renderDefinitions(
				el,
				HISTORY_FIELDS.map((field) => fieldRow(ctx, field)),
			);
			renderConfig(el);
			renderTogether(el);
		},
	};
	return view;
}

function modeText(settings: MdsyncSettings, mode: ESyncMode): string {
	if (mode === ESyncMode.Manual) {
		return "Nothing leaves this device until you push, and nothing arrives until you pull.";
	}
	const when = ["at startup"];
	if (settings.autoSyncIntervalMinutes > 0) {
		when.push(`every ${pluralize(settings.autoSyncIntervalMinutes, "minute")}`);
	}
	if (settings.autoPushAfterChange) {
		when.push("a few seconds after you stop typing");
	}
	const last = when.pop();
	const automatic = `Syncs ${when.length > 0 ? `${when.join(", ")} and ${last}` : last}.`;
	if (mode === ESyncMode.Automatic) return automatic;
	const instant = `${automatic} Your other devices get each change the moment it is pushed.`;
	return isRelayConfigured(settings)
		? instant
		: `${instant} Needs a relay: the next step sets one up.`;
}
