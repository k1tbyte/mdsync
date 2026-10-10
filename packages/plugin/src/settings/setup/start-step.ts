import { Setting } from "obsidian";

import { openInvite } from "@/ui";

import { ESetupPath } from "./steps";
import type { StepView, Wizard } from "./wizard";

export function createStartStep(wizard: Wizard): StepView {
	return {
		render(el) {
			el.createEl("p", {
				text: "MDSync keeps this vault in sync through storage you own. Everything is encrypted on this device with a passphrase only you know.",
			});
			new Setting(el)
				.setName("Start syncing this vault")
				.setDesc("The first device: choose a storage and set a passphrase.")
				.addButton((b) =>
					b
						.setButtonText("Start")
						.setCta()
						.onClick(() => wizard.choose(ESetupPath.New)),
				);
			new Setting(el)
				.setName("Connect to a vault set up on another device")
				.setDesc("Use the setup link or QR code from that device.")
				.addButton((b) =>
					b
						.setButtonText("Connect")
						.onClick(() => wizard.choose(ESetupPath.Join)),
				);
			new Setting(el)
				.setName("Accept an invite to a shared folder")
				.setDesc(
					"Someone shared a folder with you. No storage of your own is needed.",
				)
				.addButton((b) =>
					b.setButtonText("Paste invite").onClick(() => {
						wizard.close();
						void openInvite(wizard.plugin);
					}),
				);
		},
	};
}
