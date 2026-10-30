import type { Menu } from "obsidian";
import { copyText } from "@/core/ui";
import type { FileDiffModel } from "@/features/sync";

/** The tab menu copies the path and each side whole; a selection in a pane copies part of one. */
export function addCopyItems(
	menu: Menu,
	path: string,
	model: FileDiffModel | null,
): void {
	menu.addItem((item) =>
		item
			.setTitle("Copy path")
			.setIcon("copy")
			.onClick(() => void copyText("Path", path)),
	);
	if (!model || model.isBinary) return;
	const sides = [
		{
			label: model.leftLabel,
			text: model.leftText,
			present: model.leftPresent,
		},
		{
			label: model.rightLabel,
			text: model.rightText,
			present: model.rightPresent,
		},
	];
	for (const { label, text, present } of sides) {
		if (!present) continue;
		menu.addItem((item) =>
			item
				.setTitle(`Copy text (${label})`)
				.setIcon("copy")
				.onClick(() => void copyText("Text", text)),
		);
	}
}
