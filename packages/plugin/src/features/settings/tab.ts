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
import {
	activeStorage,
	backendSection,
	storageIdentity,
} from "@/features/storage";
import {
	configurationScopeSection,
	encryptionSection,
	exclusionsSection,
	maintenanceSection,
	type SnapshotListResult,
} from "@/features/sync";
import { deviceTransferSection } from "@/features/transfer";
import type { SettingsTabHost } from "./host";
import { logsPage } from "./logs-view";
import { overviewGroup } from "./overview";
import { advancedSection } from "./sections/advanced";
import { automationSection } from "./sections/automation";
import { interfaceSection } from "./sections/interface";

export class MdsyncSettingTab extends PluginSettingTab {
	private readonly plugin: Plugin & SettingsTabHost;
	/** One history read per visit and compare: a toggle that redraws the tab must not read it again. */
	private history: {
		storage: string;
		checked: number;
		load: Promise<SnapshotListResult>;
	} | null = null;

	constructor(app: App, plugin: Plugin & SettingsTabHost) {
		super(app, plugin);
		this.plugin = plugin;
	}

	override hide(): void {
		settleTyping();
		this.history = null;
		super.hide();
	}

	private loadHistory(): Promise<SnapshotListResult> {
		const storage = storageIdentity(activeStorage(this.plugin.settings));
		// A compare since the last read may have seen a push.
		const checked = this.plugin.controller.getSnapshot().vaultCheck?.at ?? 0;
		if (this.history?.storage !== storage || this.history.checked !== checked) {
			const load = this.plugin.controller.history.listSnapshots();
			// A failed read is not kept: the next redraw tries again.
			load.catch(() => {
				if (this.history?.load === load) this.history = null;
			});
			this.history = { storage, checked, load };
		}
		return this.history.load;
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
							encryptionSection(ctx),
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
							automationSection(ctx, () => this.loadHistory()),
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
