import { Setting } from "obsidian";

import { alertLine } from "@/core/ui";

import type { ActionState } from "./run-action";

/** Buttons that belong to the fields above them: no separator, so they read as part of the form. */
export function actionRow(parent: HTMLElement): Setting {
	const row = new Setting(parent);
	row.settingEl.addClass("mdsync-button-row");
	return row;
}

/** The error of a `runAction` step and its accent button, disabled with `busyLabel` while it runs. */
export function busyButton(
	parent: HTMLElement,
	state: ActionState,
	label: string,
	busyLabel: string,
	act: () => Promise<void>,
): void {
	if (state.error) alertLine(parent).setText(state.error);
	actionRow(parent).addButton((b) =>
		b
			.setButtonText(state.busy ? busyLabel : label)
			.setCta()
			.setDisabled(state.busy)
			.onClick(() => void act()),
	);
}

/** A line for work that is still going. */
export function busyLine(parent: HTMLElement, text: string): void {
	const line = parent.createDiv({ cls: "mdsync-setup-busy" });
	line.createSpan({ cls: "mdsync-status-spinner" });
	line.createSpan({ text });
}
