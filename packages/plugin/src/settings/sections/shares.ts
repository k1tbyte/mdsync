import { Setting } from "obsidian";

import { type FieldContext, renderField } from "@/settings/fields";
import { EFieldKind } from "@/storage/field-spec";
import { openInvite, openShareWindow, shareSummary } from "@/ui";

/** This person's open shares, each managed in its window, even on a device where the folder is gone. */
export function renderSharesSection(
	parent: HTMLElement,
	ctx: FieldContext,
): void {
	const { plugin, rerender } = ctx;
	new Setting(parent).setName("Shared folders").setHeading();
	renderField(parent, ctx, {
		kind: EFieldKind.Toggle,
		name: "Push shared folders right away",
		desc: "A change in a shared folder reaches the others a couple of seconds after you stop, whatever the vault's auto-push says. Read-only folders never push.",
		get: (s) => s.pushSharesRightAway,
		set: (v) => ({ pushSharesRightAway: v }),
	});
	renderField(parent, ctx, {
		kind: EFieldKind.Toggle,
		name: "Pause shared folders added on other devices",
		desc: "They arrive here paused, before anything is pulled, until you resume them. This device only.",
		get: (s) => s.pauseArrivingShares,
		set: (v) => ({ pauseArrivingShares: v }),
	});
	new Setting(parent)
		.setName("Accept an invite")
		.setDesc(
			"Paste a link someone sent you, when opening it lands in another vault.",
		)
		.addButton((button) =>
			button.setButtonText("Paste link").onClick(() => openInvite(plugin)),
		);
	const open = plugin.spaces.list().filter((record) => !record.closed);
	if (open.length === 0) {
		new Setting(parent).setDesc(
			"Nothing shared yet. Open a folder's menu in the file explorer and select Obsync: Share folder.",
		);
	}
	for (const record of open) {
		new Setting(parent)
			.setName(record.name)
			.setDesc(shareSummary(plugin.spaces, record))
			.addButton((button) =>
				button
					.setButtonText("Manage")
					.onClick(() => openShareWindow(plugin, record, rerender)),
			);
	}
}
