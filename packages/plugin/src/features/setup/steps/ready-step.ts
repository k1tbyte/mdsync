import { setIcon } from "obsidian";
import { HISTORY_KEEP_TEXT } from "@/core/constants";
import { isRelayConfigured } from "@/core/settings";
import {
	activeStorage,
	describeStorageTarget,
	isStorageConfigured,
} from "@/features/storage";
import { canSync } from "@/features/sync";
import { ESyncMode, syncModeOf } from "../feature-choices";
import type { StepView, Wizard } from "../wizard";
import { renderDoneTour } from "./done-tour";
import { createFirstSync } from "./first-sync";

const MODE_TEXT: Record<ESyncMode, string> = {
	[ESyncMode.Manual]: "Manual: when you push and pull",
	[ESyncMode.Automatic]: "Automatic",
	[ESyncMode.Instant]: "Instant, over the relay",
};

function summaryRow(
	list: HTMLElement,
	icon: string,
	label: string,
	value: string,
	on: boolean,
): void {
	const row = list.createEl("li", { cls: "mdsync-summary-row" });
	row.toggleClass("is-off", !on);
	setIcon(row.createSpan({ cls: "mdsync-summary-icon" }), icon);
	const text = row.createDiv({ cls: "mdsync-summary-text" });
	text.createDiv({ cls: "mdsync-summary-label", text: label });
	text.createDiv({ cls: "mdsync-summary-value", text: value });
	setIcon(
		row.createSpan({ cls: "mdsync-summary-state" }),
		on ? "check" : "minus",
	);
}

export function createReadyStep(wizard: Wizard): StepView {
	const { plugin } = wizard;
	const firstSync = createFirstSync(wizard);

	const renderSummary = (el: HTMLElement): void => {
		const { settings } = plugin;
		const list = el.createEl("ul", { cls: "mdsync-summary" });
		const storage = isStorageConfigured(settings);
		summaryRow(
			list,
			"hard-drive",
			"Storage",
			storage ? describeStorageTarget(activeStorage(settings)) : "Not set up",
			storage,
		);
		summaryRow(
			list,
			"key-round",
			"Encryption",
			!plugin.passphrase.has()
				? "No passphrase yet"
				: settings.cachePassphrase
					? "Passphrase saved on this device"
					: "Passphrase unlocked for this session",
			plugin.passphrase.has(),
		);
		const relay = isRelayConfigured(settings);
		summaryRow(
			list,
			"radio-tower",
			"Relay",
			relay ? settings.relayUrl : "Not set up (optional)",
			relay,
		);
		const mode = syncModeOf(settings);
		summaryRow(list, "refresh-cw", "When to sync", MODE_TEXT[mode], true);
		summaryRow(
			list,
			"history",
			"History",
			!settings.fileHistoryEnabled
				? "Off"
				: settings.fileHistoryKeep === "forever"
					? "Kept forever"
					: `Kept for ${HISTORY_KEEP_TEXT[settings.fileHistoryKeep]}`,
			settings.fileHistoryEnabled,
		);
	};

	const view: StepView = {
		render(el) {
			if (!canSync(plugin.settings)) {
				const hero = el.createDiv({ cls: "mdsync-hero" });
				setIcon(hero.createDiv({ cls: "mdsync-hero-icon" }), "sparkles");
				const text = hero.createDiv({ cls: "mdsync-hero-text" });
				text.createEl("h3", { text: "Almost there" });
				text.createEl("p", { text: "Set up a storage to start syncing." });
				renderSummary(el);
				return;
			}
			firstSync.start();
			if (firstSync.done()) {
				renderDoneTour(el, wizard);
				return;
			}
			firstSync.render(el);
			el.createEl("h4", {
				cls: "mdsync-setup-heading",
				text: "On this device",
			});
			renderSummary(el);
		},
		quietFooter: () => canSync(plugin.settings) && firstSync.leads(),
	};
	return view;
}
