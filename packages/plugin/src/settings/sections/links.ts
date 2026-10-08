import { Setting } from "obsidian";

import type { PluginHost } from "@/plugin/host";
import { openManageLinks } from "@/ui";

export function renderLinksSection(
	parent: HTMLElement,
	plugin: PluginHost,
): void {
	new Setting(parent).setName("Share links").setHeading();
	const count = plugin.sharedLinks.all().length;
	new Setting(parent)
		.setName("Notes shared by link")
		.setDesc(
			`${count === 0 ? "None yet. " : `${count} on this device. `}A link publishes one note, encrypted on this device, to your relay. Create one from the note's menu: MDSync: Share link.`,
		)
		.addButton((button) =>
			button.setButtonText("Manage").onClick(() => openManageLinks(plugin)),
		);
}
