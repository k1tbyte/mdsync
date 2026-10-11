import type { SettingDefinitionGroup } from "obsidian";

import { type FieldContext, group } from "@/settings/fields";
import { openManageLinks } from "@/ui";

export function linksSection({ plugin }: FieldContext): SettingDefinitionGroup {
	return group("Share links", [
		{
			name: "Notes shared by link",
			render: (setting) => {
				const count = plugin.sharedLinks.all().length;
				setting
					.setDesc(
						`${count === 0 ? "None yet. " : `${count} on this device. `}A link publishes one note, encrypted on this device, to your relay. Create one from the note's menu: MDSync: Share link.`,
					)
					.addButton((button) =>
						button
							.setButtonText("Manage")
							.onClick(() => openManageLinks(plugin)),
					);
			},
		},
	]);
}
