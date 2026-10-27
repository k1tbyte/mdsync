import {
	type App,
	type Plugin,
	PluginSettingTab,
	type SettingDefinitionItem,
} from "obsidian";
import { type FieldContext, settleTyping } from "@/core/settings";
import { linksSection } from "@/features/links";
import { relaySection } from "@/features/relay";
import { sharesSection } from "@/features/spaces";
import { backendSection } from "@/features/storage";
import {
	configurationScopeSection,
	exclusionsSection,
	maintenanceSection,
} from "@/features/sync";
import { deviceTransferSection } from "@/features/transfer";
import type { SettingsTabHost } from "./host";
import { logsPage } from "./logs-view";
import { overviewGroup } from "./overview";
import { advancedSection } from "./sections/advanced";
import { automationSection } from "./sections/automation";
import { interfaceSection } from "./sections/interface";
import { securitySection } from "./sections/security";

export class MdsyncSettingTab extends PluginSettingTab {
	private readonly plugin: Plugin & SettingsTabHost;

	constructor(app: App, plugin: Plugin & SettingsTabHost) {
		super(app, plugin);
		this.plugin = plugin;
	}

	override hide(): void {
		settleTyping();
		super.hide();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const ctx: FieldContext<SettingsTabHost> = {
			plugin: this.plugin,
			rerender: () => this.update(),
		};
		return [
			overviewGroup(ctx),
			{
				type: "group",
				// The row order picks each page's icon in CSS.
				cls: "mdsync-settings-sections",
				items: [
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
						displayValue: () => {
							const open = this.plugin.spaces
								.list()
								.filter((record) => !record.closed).length;
							return open ? `${open} shared` : "";
						},
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
				],
			},
		];
	}
}
