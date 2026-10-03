import { Setting } from "obsidian";

import { type FieldContext, renderField } from "@/settings/fields";
import { ownerNameOf, renameOwner } from "@/spaces";
import { EFieldKind } from "@/storage";
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
		name: "Use shared folders on this device",
		desc: "Off, none of them syncs or shows up here, and the relay carries only the vault. Their folders already here stay as they are. This device only.",
		get: (s) => s.useSharedFolders,
		set: (v) => ({ useSharedFolders: v }),
		after: (host) => {
			// A pull or push running now would go on writing into a share.
			if (!host.settings.useSharedFolders) host.controller.cancel();
			void host.controller.refresh();
		},
		rerender: true,
	});
	if (!plugin.settings.useSharedFolders) return;
	const open = plugin.spaces.list().filter((record) => !record.closed);
	// Kept on the shares themselves, so it only exists once there is one to show it in.
	if (open.some(({ access }) => access.kind === "owner")) {
		renderField(parent, ctx, {
			kind: EFieldKind.Text,
			name: "Your name",
			desc: "How the people you share folders with see you. Empty shows Owner.",
			placeholder: "Owner",
			get: (s) => ownerNameOf(s.spaces),
			set: (name, host) => ({
				spaces: renameOwner(
					host.settings.spaces,
					name.trim(),
					host.controller.currentDevice().id,
				),
			}),
		});
	}
	renderField(parent, ctx, {
		kind: EFieldKind.Toggle,
		name: "Push shared folders right away",
		desc: "A change in a shared folder reaches the others a couple of seconds after you stop, whatever the vault's auto-push says. Read-only folders never push.",
		get: (s) => s.pushSharesRightAway,
		set: (v) => ({ pushSharesRightAway: v }),
		rerender: true,
	});
	renderField(parent, ctx, {
		kind: EFieldKind.Toggle,
		name: "Push only added, moved and deleted files",
		desc: "Edits wait for your push, so their gutter marks show what changed. Open notes still update live.",
		when: (s) => s.pushSharesRightAway,
		sub: true,
		get: (s) => s.shareEditsWait,
		set: (v) => ({ shareEditsWait: v }),
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
			button.setButtonText("Paste link").onClick(() => void openInvite(plugin)),
		);
	if (open.length === 0) {
		new Setting(parent).setDesc(
			"Nothing shared yet. Open a folder's menu in the file explorer and select MDSync: Share folder.",
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
