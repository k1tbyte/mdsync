import type { SettingDefinitionGroup } from "obsidian";

import {
	type FieldContext,
	fieldRow,
	group,
	type SettingsField,
} from "@/settings/fields";
import { EFieldKind } from "@/storage";

const INTERFACE_FIELDS: ReadonlyArray<SettingsField> = [
	{
		kind: EFieldKind.Toggle,
		name: "Status bar indicator",
		desc: "Applies after Obsidian restarts.",
		get: (s) => s.showStatusBar,
		set: (v) => ({ showStatusBar: v }),
	},
	{
		kind: EFieldKind.Toggle,
		name: "Ribbon icon",
		desc: "Applies after Obsidian restarts.",
		get: (s) => s.showRibbonIcon,
		set: (v) => ({ showRibbonIcon: v }),
	},
	{
		kind: EFieldKind.Toggle,
		name: "File and folder indicators",
		desc: "Show change marks, linked and ignored paths, who is in a note and new-note dots in the file tree, and a linked or ignored label for the open note. Share badges always stay: they open the share window.",
		get: (s) => s.showFileExplorerIndicators,
		set: (v) => ({ showFileExplorerIndicators: v }),
		after: (plugin) =>
			plugin.refreshFileIndicators(plugin.settings.showFileExplorerIndicators),
	},
	{
		kind: EFieldKind.Toggle,
		name: "Editor change signs",
		desc: "Show per-line gutter marks for changes since the last sync.",
		get: (s) => s.showEditorChangeSigns,
		set: (v) => ({ showEditorChangeSigns: v }),
		after: (plugin) =>
			plugin.refreshEditorSigns(plugin.settings.showEditorChangeSigns),
	},
	{
		kind: EFieldKind.Toggle,
		name: "File sizes in changes",
		desc: "Show current sizes and size changes in the Changes list.",
		get: (s) => s.showFileSizes,
		set: (v) => ({ showFileSizes: v }),
		after: (plugin) => plugin.refreshSourceControlView(),
	},
];

export function interfaceSection(ctx: FieldContext): SettingDefinitionGroup {
	return group(
		undefined,
		INTERFACE_FIELDS.map((field) => fieldRow(ctx, field)),
	);
}
