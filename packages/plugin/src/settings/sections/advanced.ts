import { debounce, type SettingDefinitionGroup } from "obsidian";

import { type FieldContext, group, TYPING_SETTLE_MS } from "@/settings/fields";
import { defaultDeviceName } from "@/sync/device";

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
							debounce(
								(value) => void plugin.device.rename(value),
								TYPING_SETTLE_MS,
								true,
							),
						),
				);
			},
		},
	]);
}
