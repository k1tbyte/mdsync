import { Setting } from "obsidian";

import { type FieldContext, renderField } from "@/settings/fields";
import { EFieldKind } from "@/storage/field-spec";
import { openShareWindow } from "@/ui";

/** This person's open shares, each managed in its window, even on a device where the folder is gone. */
export function renderSharesSection(
	parent: HTMLElement,
	ctx: FieldContext,
): void {
	const { plugin, rerender } = ctx;
	new Setting(parent).setName("Shared folders").setHeading();
	renderField(parent, ctx, {
		kind: EFieldKind.Toggle,
		name: "Pause shared folders added on other devices",
		desc: "They arrive here paused, before anything is pulled, until you resume them. This device only.",
		get: (s) => s.pauseArrivingShares,
		set: (v) => ({ pauseArrivingShares: v }),
	});
	for (const record of plugin.spaces.list()) {
		if (record.closed) continue;
		const whose = record.access.kind === "owner" ? "Yours" : "Shared with you";
		new Setting(parent)
			.setName(record.name)
			.setDesc(`${whose}, in "${record.root}"`)
			.addButton((button) =>
				button
					.setButtonText("Manage")
					.onClick(() => openShareWindow(plugin, record, rerender)),
			);
	}
}
