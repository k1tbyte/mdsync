import { Setting, type SettingDefinitionGroup } from "obsidian";
import {
	type FieldContext,
	fieldRow,
	group,
	imperativePage,
	introRow,
} from "@/core/settings";
import { EFieldKind } from "@/features/storage";
import { ownerNameOf, renameOwner } from "../owner";
import { openInvite } from "./invites/invite-action";
import { shareSummary } from "./window/share-summary";
import { openShareWindow } from "./window/share-window";

/** This person's open shares, each managed in its window, even on a device where the folder is gone. */
export function sharesSection(ctx: FieldContext): SettingDefinitionGroup {
	const { plugin } = ctx;
	const open = () => plugin.spaces.list().filter((record) => !record.closed);
	const enabled = () => plugin.settings.useSharedFolders;
	return group("Shared folders", [
		fieldRow(ctx, {
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
		}),
		fieldRow(ctx, {
			when: () =>
				enabled() && open().some(({ access }) => access.kind === "owner"),
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
		}),
		fieldRow(ctx, {
			when: enabled,
			kind: EFieldKind.Toggle,
			name: "Push shared folders right away",
			desc: "A change in a shared folder reaches the others a couple of seconds after you stop, whatever the vault's auto-push says. Read-only folders never push.",
			get: (s) => s.pushSharesRightAway,
			set: (v) => ({ pushSharesRightAway: v }),
			rerender: true,
		}),
		fieldRow(ctx, {
			when: (s) => enabled() && s.pushSharesRightAway,
			kind: EFieldKind.Toggle,
			name: "Push only added, moved and deleted files",
			desc: "Edits wait for your push, so their gutter marks show what changed. Open notes still update live.",
			sub: true,
			get: (s) => s.shareEditsWait,
			set: (v) => ({ shareEditsWait: v }),
		}),
		fieldRow(ctx, {
			when: enabled,
			kind: EFieldKind.Toggle,
			name: "Pause shared folders added on other devices",
			desc: "They arrive here paused, before anything is pulled, until you resume them. This device only.",
			get: (s) => s.pauseArrivingShares,
			set: (v) => ({ pauseArrivingShares: v }),
		}),
		{
			name: "Accept an invite",
			desc: "Paste a link someone sent you, when opening it lands in another vault.",
			visible: enabled,
			render: (setting) => {
				setting.addButton((button) =>
					button
						.setButtonText("Paste link")
						.onClick(() => void openInvite(plugin)),
				);
			},
		},
		{
			...introRow(
				"Nothing shared yet. Open a folder's menu in the file explorer and select MDSync: Share folder.",
			),
			visible: () => enabled() && open().length === 0,
		},
		{
			type: "page",
			name: "Your shared folders",
			visible: () => enabled() && open().length > 0,
			displayValue: () => String(open().length),
			page: () =>
				imperativePage("Your shared folders", (parent, refresh) => {
					for (const record of open()) {
						new Setting(parent)
							.setName(record.name)
							.setDesc(shareSummary(plugin.spaces, record))
							.addButton((button) =>
								button
									.setButtonText("Manage")
									.onClick(() => openShareWindow(plugin, record, refresh)),
							);
					}
				}),
		},
	]);
}
