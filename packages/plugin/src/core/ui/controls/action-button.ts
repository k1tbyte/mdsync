import { ButtonComponent } from "obsidian";

export type ActionTone = "cta" | "warning";

export function actionButton(
	parent: HTMLElement,
	tone: ActionTone,
): ButtonComponent {
	const button = new ButtonComponent(parent);
	return tone === "warning" ? button.setDestructive() : button.setCta();
}

/** Text cut with an ellipsis in a narrow pane: a bare text node in a flex button cannot be. */
export function textButton(parent: HTMLElement, text: string): ButtonComponent {
	const button = new ButtonComponent(parent);
	button.buttonEl.createSpan({ cls: "mdsync-button-text", text });
	return button;
}
