import { Setting } from "obsidian";

import type { PluginHost } from "@/plugin/host";
import { openShareWindow } from "@/ui";

/** This person's open shares, each managed in its window, even on a device where the folder is gone. */
export function renderSharesSection(
	parent: HTMLElement,
	plugin: PluginHost,
	onChange: () => void,
): void {
	const records = plugin.spaces.list().filter((record) => !record.closed);
	if (records.length === 0) return;
	new Setting(parent).setName("Shared folders").setHeading();
	for (const record of records) {
		const whose = record.access.kind === "owner" ? "Yours" : "Shared with you";
		new Setting(parent)
			.setName(record.name)
			.setDesc(`${whose}, in "${record.root}"`)
			.addButton((button) =>
				button
					.setButtonText("Manage")
					.onClick(() => openShareWindow(plugin, record, onChange)),
			);
	}
}
