import { Setting } from "obsidian";

import { SOURCE_CONTROL_VIEW_TYPE } from "@/constants";
import { renderFields } from "@/settings/fields";
import { canSync } from "@/settings/model";
import { SETUP_FIELDS } from "@/settings/sections";
import type { SyncStatusSnapshot } from "@/sync/controller";
import { openSourceControlView, showSettingsTransferExport } from "@/ui";
import { alertLine } from "@/ui/common";

import type { StepView, Wizard } from "./wizard";

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
		const { error, conflicts, pendingLocal, pendingRemote } = synced;
		const left = conflicts + pendingLocal + pendingRemote;
		if (error) {
			alertLine(el).setText(error);
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

	const view: StepView = {
		render(el) {
			el.createEl("h3", { text: "Ready to sync" });
			renderSync(el);
			renderFields(
				el,
				{ plugin, rerender: () => wizard.redraw() },
				SETUP_FIELDS,
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
