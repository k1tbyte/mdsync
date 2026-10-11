import {
	debounce,
	Setting,
	type SettingDefinitionGroup,
	type SettingDefinitionRender,
	type SettingGroupItem,
} from "obsidian";

import type { PluginHost } from "@/plugin/host";
import { EFieldKind } from "@/storage";

import type { ConnectionTestResult } from "./connection-test";
import type { MdsyncSettings } from "./model";

export const SUB_SETTING_CLASS = "mdsync-sub-setting";
const ERROR_DESC_CLASS = "mdsync-settings-error";
/** A relay URL typed letter by letter must not open a socket, or send a grant, per prefix. */
export const TYPING_SETTLE_MS = 800;
const WHOLE_NUMBER = /^\s*\d+\s*$/;

export interface FieldContext {
	plugin: PluginHost;
	rerender: () => void;
}

interface FieldBase {
	name: string;
	desc?: string;
	when?: (settings: MdsyncSettings) => boolean;
	sub?: boolean;
	/** For scope-affecting settings. */
	refreshScope?: boolean;
	rerender?: boolean;
	after?: (plugin: PluginHost) => void;
}

export interface ToggleField extends FieldBase {
	kind: typeof EFieldKind.Toggle;
	get: (settings: MdsyncSettings) => boolean;
	set: (value: boolean, plugin: PluginHost) => Partial<MdsyncSettings>;
}

export interface TextField extends FieldBase {
	kind: typeof EFieldKind.Text | typeof EFieldKind.Password;
	placeholder?: string;
	get: (settings: MdsyncSettings) => string;
	set: (value: string, plugin: PluginHost) => Partial<MdsyncSettings>;
}

export interface NumberField extends FieldBase {
	kind: typeof EFieldKind.Number;
	get: (settings: MdsyncSettings) => string;
	parse: (raw: string) => number;
	set: (value: number, plugin: PluginHost) => Partial<MdsyncSettings>;
}

export interface SliderField extends FieldBase {
	kind: typeof EFieldKind.Slider;
	min: number;
	max: number;
	step?: number;
	get: (settings: MdsyncSettings) => number;
	set: (value: number, plugin: PluginHost) => Partial<MdsyncSettings>;
}

export type SettingsField = ToggleField | TextField | NumberField | SliderField;

export type SettingsRow = Omit<SettingDefinitionRender, "render"> & {
	render: (setting: Setting) => ReturnType<SettingDefinitionRender["render"]>;
};

export function fieldRow(ctx: FieldContext, field: SettingsField): SettingsRow {
	const { when } = field;
	return {
		name: field.name,
		desc: field.desc,
		visible: when ? () => when(ctx.plugin.settings) : undefined,
		render: (setting) => {
			applyControl(setting, ctx, field);
		},
	};
}

function applyControl(
	setting: Setting,
	ctx: FieldContext,
	field: SettingsField,
): Setting {
	if (field.sub) setting.settingEl.addClass(SUB_SETTING_CLASS);

	const apply = (patch: Partial<MdsyncSettings>): void => {
		applyPatch(ctx, patch, field);
	};
	const applyTyped = debounce(apply, TYPING_SETTLE_MS, true);
	const type = (patch: Partial<MdsyncSettings>): void => {
		Object.assign(ctx.plugin.settings, patch);
		applyTyped(patch);
	};

	if (field.kind === EFieldKind.Toggle) {
		return setting.addToggle((toggle) =>
			toggle
				.setValue(field.get(ctx.plugin.settings))
				.onChange((value) => apply(field.set(value, ctx.plugin))),
		);
	}

	if (field.kind === EFieldKind.Number) {
		return setting.addText((text) =>
			text.setValue(field.get(ctx.plugin.settings)).onChange((raw) => {
				if (!WHOLE_NUMBER.test(raw)) return;
				type(field.set(field.parse(raw), ctx.plugin));
			}),
		);
	}

	if (field.kind === EFieldKind.Slider) {
		return setting.addSlider((slider) =>
			slider
				.setLimits(field.min, field.max, field.step ?? 1)
				.setValue(field.get(ctx.plugin.settings))
				.onChange((value) => apply(field.set(value, ctx.plugin))),
		);
	}

	return setting.addText((text) => {
		if (field.kind === EFieldKind.Password) text.inputEl.type = "password";
		if (field.placeholder) text.setPlaceholder(field.placeholder);
		text
			.setValue(field.get(ctx.plugin.settings))
			.onChange((value) => type(field.set(value, ctx.plugin)));
	});
}

/** A Test button whose outcome replaces the row description. */
export function checkRow(
	name: string,
	desc: string,
	run: () => Promise<ConnectionTestResult>,
): SettingsRow {
	return {
		name,
		desc,
		render: (setting) => {
			setting.addButton((button) => {
				button.setButtonText("Test").onClick(async () => {
					button.setDisabled(true);
					button.setButtonText("Testing…");
					const result = await run();
					setting.setDesc(result.message);
					setting.descEl.toggleClass(ERROR_DESC_CLASS, !result.ok);
					button.setDisabled(false);
					button.setButtonText("Test");
				});
			});
		},
	};
}

export function group(
	heading: string | undefined,
	items: SettingGroupItem[],
): SettingDefinitionGroup {
	return { type: "group", heading, cls: "mdsync-settings", items };
}

export function introRow(text: string): SettingsRow {
	return {
		name: text,
		desc: text,
		searchable: false,
		render: (setting) => {
			setting.setName("");
		},
	};
}

export function renderDefinitions(
	parent: HTMLElement,
	items: ReadonlyArray<SettingsRow | SettingDefinitionGroup>,
): void {
	for (const item of items) {
		if (
			typeof item.visible === "function"
				? !item.visible()
				: item.visible === false
		)
			continue;
		if ("type" in item) {
			if (item.heading) new Setting(parent).setName(item.heading).setHeading();
			renderDefinitions(parent, (item.items ?? []) as SettingsRow[]);
		} else {
			const setting = new Setting(parent).setName(item.name);
			if (item.desc !== undefined) setting.setDesc(item.desc);
			item.render(setting);
		}
	}
}

function applyPatch(
	ctx: FieldContext,
	patch: Partial<MdsyncSettings>,
	field: SettingsField,
): void {
	Object.assign(ctx.plugin.settings, patch);
	void ctx.plugin.saveSettings().then(() => {
		if (field.refreshScope) {
			ctx.plugin.scheduleScopeRefresh("Sync scope settings changed.");
		}
		field.after?.(ctx.plugin);
		if (field.rerender) ctx.rerender();
	});
}
