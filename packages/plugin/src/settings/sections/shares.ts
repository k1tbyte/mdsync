import { Setting } from "obsidian";

import type { PluginHost } from "@/plugin/host";
import { isRelayConfigured } from "@/settings/model";
import { closeShare, openParticipants } from "@/ui";

/** This person's open shares, closable even on a device where the folder is gone. */
export function renderSharesSection(
	parent: HTMLElement,
	plugin: PluginHost,
	onChange: () => void,
): void {
	const records = plugin.spaces.list().filter((record) => !record.closed);
	if (records.length === 0) return;
	new Setting(parent).setName("Shared folders").setHeading();
	const paused = plugin.spaces.paused();
	const inert = new Set(plugin.spaces.inert().map((record) => record.id));
	for (const record of records) {
		const owner = record.access.kind === "owner";
		const here = paused.has(record.id);
		const stuck = inert.has(record.id);
		const row = new Setting(parent)
			.setName(record.name)
			.setDesc(
				stuck
					? `Not syncing: another shared folder already holds "${record.root}".`
					: `${owner ? "Yours" : "Shared with you"}, in "${record.root}"${here ? ", paused on this device" : ""}`,
			);
		if (!stuck) {
			row.addButton((button) =>
				button
					.setButtonText(here ? "Resume here" : "Pause here")
					.setTooltip("Only this device; the others keep syncing it.")
					.onClick(async () => {
						await plugin.spaces.setPaused(record.id, !here);
						onChange();
						void plugin.controller.refresh();
					}),
			);
		}
		// Invites go through the relay, so only it knows who holds one.
		if (owner && !stuck && isRelayConfigured(plugin.settings)) {
			row.addButton((button) =>
				button
					.setButtonText("People")
					.onClick(() => openParticipants(plugin, record)),
			);
		}
		row.addButton((button) =>
			button
				.setButtonText(owner ? "Stop sharing" : "Leave")
				.setWarning()
				.onClick(async () => {
					await closeShare(plugin, record);
					onChange();
				}),
		);
	}
}
