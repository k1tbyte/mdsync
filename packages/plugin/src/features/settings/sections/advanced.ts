import type { SettingDefinitionGroup } from "obsidian";

import { type FieldContext, group, onSettled } from "@/core/settings";
import { defaultDeviceName } from "@/features/sync";

export function advancedSection({
	plugin,
}: FieldContext): SettingDefinitionGroup {
	return group("Advanced", [
		{
			name: "Device name",
			desc: "Shown in file history so you can tell devices apart. Stored locally on this device; never synced.",
			render: (setting) => {
				setting.addText((text) =>
					text
						.setPlaceholder(defaultDeviceName())
						.setValue(plugin.device.current())
						.onChange(
							onSettled((value: string) => void plugin.device.rename(value)),
						),
				);
			},
		},
	]);
}
