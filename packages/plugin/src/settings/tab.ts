import {
	type App,
	type Plugin,
	PluginSettingTab,
	type SettingDefinitionItem,
} from "obsidian";

import type { PluginHost } from "@/plugin/host";
import { type FieldContext, group, settleTyping } from "./fields";
import { logsPage } from "./logs-view";
import { canSync } from "./model";
import {
	advancedSection,
	automationSection,
	backendSection,
	configurationScopeSection,
	deviceTransferSection,
	exclusionsSection,
	interfaceSection,
	linksSection,
	maintenanceSection,
	relaySection,
	securitySection,
	sharesSection,
} from "./sections";

export class MdsyncSettingTab extends PluginSettingTab {
	private readonly plugin: Plugin & PluginHost;

	constructor(app: App, plugin: Plugin & PluginHost) {
		super(app, plugin);
		this.plugin = plugin;
	}

	override hide(): void {
		settleTyping();
		super.hide();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const ctx: FieldContext = {
			plugin: this.plugin,
			rerender: () => this.update(),
		};
		return [
			group(undefined, [
				{
					name: "Setup wizard",
					desc: "Storage, passphrase and relay, step by step.",
					render: (setting) => {
						setting.addButton((button) => {
							button
								.setButtonText("Open")
								.onClick(() => this.plugin.openSetup());
							if (!canSync(this.plugin.settings)) button.setCta();
						});
					},
				},
			]),
			{
				type: "page",
				name: "Connection",
				desc: "Storage, encryption, relay and device transfer.",
				items: [
					backendSection(ctx),
					securitySection(ctx),
					relaySection(ctx),
					deviceTransferSection(ctx),
					advancedSection(ctx),
				],
			},
			{
				type: "page",
				name: "Sync",
				desc: "Automation, shared folders, share links, configuration scope and exclusions.",
				items: [
					automationSection(ctx),
					sharesSection(ctx),
					linksSection(ctx),
					configurationScopeSection(ctx),
					exclusionsSection(ctx),
				],
			},
			{
				type: "page",
				name: "Interface",
				desc: "Status bar, ribbon, file indicators and editor signs.",
				items: [interfaceSection(ctx)],
			},
			{
				type: "page",
				name: "Maintenance",
				desc: "Local state, remote integrity and storage cleanup.",
				items: [maintenanceSection(ctx)],
			},
			logsPage(this.plugin),
		];
	}
}
