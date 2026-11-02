import { Platform, Setting, setIcon } from "obsidian";
import { isRelayConfigured } from "@/core/settings";
import { showSettingsTransferExport } from "@/features/transfer";
import { ESyncMode, syncModeOf } from "../feature-choices";
import { actionRow } from "../form";
import type { Wizard } from "../wizard";

const WORDS: ReadonlyArray<[string, string]> = [
	["Push", "Send this device's changes to the storage."],
	["Pull", "Take what your other devices sent."],
	["Compare", "Check both sides without moving anything."],
	[
		"Conflict",
		"A file changed on two devices. Notes merge when the changes do not overlap; otherwise you choose.",
	],
];

/** Where things live once the vault syncs: the last thing the wizard shows. */
export function renderDoneTour(el: HTMLElement, wizard: Wizard): void {
	const { plugin } = wizard;
	const { settings } = plugin;
	const hero = el.createDiv({ cls: "mdsync-hero" });
	const icon = hero.createDiv({ cls: "mdsync-hero-icon is-success" });
	setIcon(icon, "party-popper");
	const text = hero.createDiv({ cls: "mdsync-hero-text" });
	text.createEl("h3", { text: "You're all set" });
	text.createEl("p", {
		text:
			syncModeOf(settings) === ESyncMode.Manual
				? "This vault is in sync. It syncs again when you push and pull, through your storage, encrypted on this device."
				: "This vault is in sync and keeps itself in sync, through your storage, encrypted on this device.",
	});

	el.createEl("h4", {
		cls: "mdsync-setup-heading",
		text: "Where to find things",
	});
	const list = el.createEl("ul", { cls: "mdsync-summary mdsync-tour" });
	// Obsidian's mobile app has no status bar.
	if (!Platform.isMobile && settings.showStatusBar) {
		place(
			list,
			"cloud-check",
			"Status bar",
			"Where sync stands, bottom right. Select it to compare, push or pull.",
		);
	}
	place(
		list,
		"refresh-cw",
		"MDSync panel",
		Platform.isMobile
			? "In the right sidebar: what changed, past versions, deleted files and every push."
			: "What changed, past versions, deleted files and every push. The ribbon icon opens it.",
	);
	if (settings.showFileExplorerIndicators) {
		place(
			list,
			"folder-tree",
			"File tree",
			"A colour and a mark beside files changed since the last sync.",
		);
	}
	if (settings.showEditorChangeSigns) {
		place(
			list,
			"align-left",
			"Editor margin",
			"A bar beside lines changed since the last sync. Select it to see the change, push it or undo it.",
		);
	}

	el.createEl("h4", {
		cls: "mdsync-setup-heading",
		text: "Words you will see",
	});
	const words = el.createEl("dl", { cls: "mdsync-tour-words" });
	for (const [term, meaning] of WORDS) {
		words.createEl("dt", { text: term });
		words.createEl("dd", { text: meaning });
	}

	el.createEl("h4", { cls: "mdsync-setup-heading", text: "Next" });
	new Setting(el)
		.setName("Set up another device")
		.setDesc(
			"A link and QR code that bring this setup to your phone or another computer.",
		)
		.addButton((b) =>
			b.setButtonText("Show setup link").onClick(() =>
				showSettingsTransferExport(plugin.app, {
					createPackage: (options) => plugin.transfer.createPackage(options),
				}),
			),
		);
	if (!isRelayConfigured(settings)) {
		new Setting(el)
			.setName("Live editing and sharing")
			.setDesc(
				"Add a relay when you want instant sync, live editing, shared folders or share links.",
			)
			.addButton((b) =>
				b.setButtonText("Add a relay").onClick(() => plugin.openSetup("relay")),
			);
	}
	actionRow(el).addButton((b) =>
		b.setButtonText("Open MDSync panel").onClick(() => {
			wizard.close();
			void plugin.openSourceControl();
		}),
	);
}

function place(
	list: HTMLElement,
	icon: string,
	name: string,
	text: string,
): void {
	const row = list.createEl("li", {
		cls: "mdsync-summary-row mdsync-tour-row",
	});
	setIcon(row.createSpan({ cls: "mdsync-summary-icon" }), icon);
	const body = row.createDiv({ cls: "mdsync-summary-text" });
	body.createDiv({ cls: "mdsync-tour-name", text: name });
	body.createDiv({ cls: "mdsync-tour-text", text });
}
