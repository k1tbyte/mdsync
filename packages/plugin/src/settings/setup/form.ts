import { Setting, setIcon } from "obsidian";

export type CalloutTone = "info" | "warning" | "success";

const CALLOUT_ICONS: Record<CalloutTone, string> = {
	info: "info",
	warning: "triangle-alert",
	success: "circle-check",
};

/** Buttons that belong to the fields above them: no separator, so they read as part of the form. */
export function actionRow(parent: HTMLElement): Setting {
	const row = new Setting(parent);
	row.settingEl.addClass("mdsync-button-row");
	return row;
}

export function callout(
	parent: HTMLElement,
	tone: CalloutTone,
	text: string,
): HTMLElement {
	const box = parent.createDiv({ cls: `mdsync-callout is-${tone}` });
	setIcon(box.createSpan({ cls: "mdsync-callout-icon" }), CALLOUT_ICONS[tone]);
	box.createDiv({ cls: "mdsync-callout-text", text });
	return box;
}

/** A line for work that is still going. */
export function busyLine(parent: HTMLElement, text: string): void {
	const line = parent.createDiv({ cls: "mdsync-setup-busy" });
	line.createSpan({ cls: "mdsync-status-spinner" });
	line.createSpan({ text });
}
