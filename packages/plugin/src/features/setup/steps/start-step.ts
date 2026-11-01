import { Platform, setIcon } from "obsidian";

import { openInvite } from "@/features/spaces";

import { choiceCard } from "../choice-card";
import { ESetupPath } from "../step-state";
import type { StepView, Wizard } from "../wizard";

export function createStartStep(wizard: Wizard): StepView {
	return {
		render(el) {
			const hero = el.createDiv({ cls: "mdsync-hero" });
			setIcon(hero.createDiv({ cls: "mdsync-hero-icon" }), "refresh-cw");
			const text = hero.createDiv({ cls: "mdsync-hero-text" });
			text.createEl("h3", { text: "Sync your vault, privately" });
			text.createEl("p", {
				text: "MDSync keeps this vault in sync through storage you own. Everything is encrypted on this device with a passphrase only you know.",
			});
			const choices = el.createDiv({ cls: "mdsync-choices" });
			// A phone is rarely the first device: joining leads there.
			const joinFirst = Platform.isPhone;
			const start = () =>
				choiceCard(choices, {
					icon: "sparkles",
					title: "Start syncing this vault",
					desc: "The first device: choose a storage and set a passphrase.",
					primary: !joinFirst,
					onClick: () => wizard.choose(ESetupPath.New),
				});
			const join = () =>
				choiceCard(choices, {
					icon: "link",
					title: "Connect to a vault set up on another device",
					desc: "Use the setup link or QR code from that device.",
					primary: joinFirst,
					onClick: () => wizard.choose(ESetupPath.Join),
				});
			if (joinFirst) {
				join();
				start();
			} else {
				start();
				join();
			}
			choiceCard(choices, {
				icon: "folder-input",
				title: "Accept an invite to a shared folder",
				desc: "Someone shared a folder with you. No storage of your own is needed.",
				onClick: () => void openInvite(wizard.plugin, "", () => wizard.close()),
			});
		},
	};
}
