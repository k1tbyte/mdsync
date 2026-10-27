import { Setting, setIcon } from "obsidian";

import { SOURCE_CONTROL_VIEW_TYPE } from "@/core/constants";
import {
	activeStorage,
	canSync,
	fieldRow,
	isRelayConfigured,
	isStorageConfigured,
	renderDefinitions,
} from "@/core/settings";
import { alertLine } from "@/core/ui";
import { SETUP_FIELDS } from "@/features/settings/sections/automation";
import { openSourceControlView } from "@/features/source-control/view";
import { describeStorageTarget } from "@/features/storage";
import type { SyncStatusSnapshot } from "@/features/sync";
import { showSettingsTransferExport } from "@/features/transfer";

import type { StepView, Wizard } from "../wizard";

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
	const { controller } = plugin;
	let syncing = false;
	let synced: SyncStatusSnapshot | null = null;

	/** The scheduled sync's own cycle: pulls, pushes, and leaves files changed on both sides for Changes. */
	const syncNow = async (): Promise<void> => {
		syncing = true;
		wizard.redraw();
		const unsubscribe = controller.subscribe(() => wizard.redraw());
		try {
			await controller.refreshAndAutoSync(true);
		} finally {
			unsubscribe();
			syncing = false;
			synced = controller.getSnapshot();
			wizard.redraw();
		}
	};

	const renderSync = (el: HTMLElement): void => {
		const ready = canSync(plugin.settings);
		const row = new Setting(el)
			.setName("First sync")
			.setDesc(
				"Compares this vault with the storage, then pulls and pushes what changed.",
			)
			.addButton((b) =>
				b
					.setButtonText(syncing ? "Syncing…" : "Sync now")
					.setCta()
					.setDisabled(syncing || !ready)
					.onClick(() => void syncNow()),
			);
		if (!ready) {
			row.setDesc("Set up a storage first.");
			return;
		}
		if (syncing) {
			row.setDesc(controller.getSnapshot().progressText ?? "Syncing…");
			return;
		}
		if (!synced) return;
		const { error, spaceErrors, conflicts, pendingLocal, pendingRemote } =
			synced;
		const left = conflicts + pendingLocal + pendingRemote;
		if (error) {
			alertLine(el).setText(error);
			return;
		}
		if (spaceErrors.length > 0) {
			for (const { root, message } of spaceErrors) {
				alertLine(el).setText(`Error in "${root}": ${message}`);
			}
			return;
		}
		if (left === 0) {
			row.setDesc("In sync.");
			return;
		}
		row.setDesc(
			conflicts > 0
				? `${conflicts} file(s) changed both here and in the storage. Choose a side for each in Changes.`
				: `${left} change(s) were not synced. Review them in Changes.`,
		);
		row.addButton((b) =>
			b.setButtonText("Open changes").onClick(() => {
				wizard.close();
				void openSourceControlView(plugin.app, SOURCE_CONTROL_VIEW_TYPE);
			}),
		);
	};

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
	};

	const view: StepView = {
		render(el) {
			const ready = canSync(plugin.settings);
			const hero = el.createDiv({ cls: "mdsync-hero" });
			const icon = hero.createDiv({ cls: "mdsync-hero-icon" });
			icon.toggleClass("is-success", ready);
			setIcon(icon, ready ? "party-popper" : "sparkles");
			const text = hero.createDiv({ cls: "mdsync-hero-text" });
			text.createEl("h3", { text: ready ? "You're all set" : "Almost there" });
			text.createEl("p", {
				text: ready
					? "Your vault syncs through storage you own, encrypted on this device."
					: "Set up a storage to start syncing.",
			});
			renderSummary(el);
			renderSync(el);
			renderDefinitions(
				el,
				SETUP_FIELDS.map((field) =>
					fieldRow({ plugin, rerender: () => wizard.redraw() }, field),
				),
			);
			new Setting(el)
				.setName("Set up another device")
				.setDesc(
					"Shows a link and QR code that bring this setup to your phone or another computer.",
				)
				.addButton((b) =>
					b.setButtonText("Show setup link").onClick(() =>
						showSettingsTransferExport(plugin.app, {
							createPackage: (options) =>
								plugin.transfer.createPackage(options),
						}),
					),
				);
		},
	};
	return view;
}
