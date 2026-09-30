import { type App, ButtonComponent, Modal } from "obsidian";

import { onEnter } from "@/ui/common/enter-key";

import { openPromiseModal } from "./promise-modal";

export interface PromptModalOptions {
	app: App;
	title: string;
	description?: string;
	initialValue: string;
	confirmLabel: string;
	/** Announced for the field; the description alone is not tied to the input. */
	label: string;
	/** Lets an empty answer through, for fields whose whole point is clearing. */
	allowEmpty?: boolean;
}

/** Answers with the trimmed text, or null when dismissed (or left empty). */
export function openPromptModal(
	options: PromptModalOptions,
): Promise<string | null> {
	return openPromiseModal<string | null>((answer) => {
		const modal = new Modal(options.app);
		const finish = (value: string | null): void => {
			answer(value);
			modal.close();
		};
		modal.titleEl.setText(options.title);
		if (options.description) {
			modal.contentEl.createEl("p", { text: options.description });
		}
		const input = modal.contentEl.createEl("input", {
			type: "text",
			cls: "obsync-prompt-input",
		});
		input.setAttr("aria-label", options.label);
		input.value = options.initialValue;
		const blank = (): boolean => !options.allowEmpty && !input.value.trim();
		const submit = (): void => {
			if (!blank()) finish(input.value.trim());
		};
		onEnter(input, submit);
		const buttons = modal.contentEl.createDiv({ cls: "obsync-modal-buttons" });
		new ButtonComponent(buttons)
			.setButtonText("Cancel")
			.onClick(() => finish(null));
		const confirm = new ButtonComponent(buttons)
			.setButtonText(options.confirmLabel)
			.setCta()
			.setDisabled(blank())
			.onClick(submit);
		input.addEventListener("input", () => confirm.setDisabled(blank()));
		window.setTimeout(() => input.focus(), 0);
		return modal;
	}, null);
}
