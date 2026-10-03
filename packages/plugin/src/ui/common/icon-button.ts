import { setIcon } from "obsidian";

export function appendIconButton(
	parent: HTMLElement,
	icon: string,
	label: string,
	onClick: (event: MouseEvent) => void,
): HTMLButtonElement {
	const button = parent.createEl("button", { cls: "mdsync-icon-btn" });
	button.type = "button";
	button.setAttr("aria-label", label);
	setIcon(button, icon);
	button.addEventListener("click", onClick);
	return button;
}

/** Icon plus text: a bare icon button left dead space in a full-width toolbar. */
export function appendLabeledButton(
	parent: HTMLElement,
	icon: string,
	label: string,
	onClick: (event: MouseEvent) => void,
): HTMLButtonElement {
	const button = parent.createEl("button", { cls: "mdsync-labeled-btn" });
	button.type = "button";
	const iconEl = button.createSpan({ cls: "mdsync-labeled-btn-icon" });
	setIcon(iconEl, icon);
	button.createSpan({ text: label });
	button.addEventListener("click", onClick);
	return button;
}
