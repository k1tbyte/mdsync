import { ButtonComponent } from "obsidian";

export type ActionTone = "cta" | "warning";

export function actionButton(
	parent: HTMLElement,
	tone: ActionTone,
): ButtonComponent {
	const button = new ButtonComponent(parent);
	return tone === "warning" ? button.setDestructive() : button.setCta();
}
