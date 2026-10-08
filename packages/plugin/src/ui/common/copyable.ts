import { Setting } from "obsidian";

import { runWithNotice } from "./notices";

/** A read-only field with a copy button. */
export function copyable(el: HTMLElement, name: string, value: string): void {
	new Setting(el)
		.setName(name)
		.addText((text) => {
			text.setValue(value);
			text.inputEl.readOnly = true;
		})
		.addExtraButton((button) =>
			button
				.setIcon("copy")
				.setTooltip(`Copy ${name.toLowerCase()}`)
				.onClick(() => void copyText(name, value)),
		);
}

export function copyText(name: string, value: string): Promise<boolean> {
	return runWithNotice(
		() => navigator.clipboard.writeText(value),
		`${name} copied.`,
		`Could not copy the ${name.toLowerCase()}`,
	);
}
