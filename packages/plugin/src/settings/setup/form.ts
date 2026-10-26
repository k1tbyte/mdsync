import { Setting } from "obsidian";

/** Buttons that belong to the fields above them: no separator, so they read as part of the form. */
export function actionRow(parent: HTMLElement): Setting {
	const row = new Setting(parent);
	row.settingEl.addClass("mdsync-button-row");
	return row;
}

/** A line for work that is still going. */
export function busyLine(parent: HTMLElement, text: string): void {
	const line = parent.createDiv({ cls: "mdsync-setup-busy" });
	line.createSpan({ cls: "mdsync-status-spinner" });
	line.createSpan({ text });
}
