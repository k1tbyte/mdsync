import { setIcon } from "obsidian";

export type CalloutTone = "info" | "warning" | "success" | "error";

const CALLOUT_ICONS: Record<CalloutTone, string> = {
	info: "info",
	warning: "triangle-alert",
	success: "circle-check",
	error: "triangle-alert",
};

/** A tinted note with an icon; returns the text column, where a button can follow. */
export function callout(
	parent: HTMLElement,
	tone: CalloutTone,
	text: string,
	title?: string,
): HTMLElement {
	const box = parent.createDiv({ cls: `mdsync-callout is-${tone}` });
	if (tone === "error") box.setAttr("role", "alert");
	setIcon(box.createSpan({ cls: "mdsync-callout-icon" }), CALLOUT_ICONS[tone]);
	const copy = box.createDiv({ cls: "mdsync-callout-copy" });
	if (title) copy.createDiv({ cls: "mdsync-callout-title", text: title });
	copy.createDiv({ cls: "mdsync-callout-text", text });
	return copy;
}
