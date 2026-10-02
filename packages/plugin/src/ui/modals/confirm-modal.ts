import { type App, ButtonComponent, Modal } from "obsidian";

import { openPromiseModal } from "./promise-modal";

type ButtonClass = "mod-cta" | "mod-warning";

export interface ConfirmModalOptions {
	app: App;
	title: string;
	body: ReadonlyArray<string>;
	confirmLabel: string;
	confirmClass?: ButtonClass;
	cancelLabel?: string;
}

export interface ChoiceModalOptions<K extends string> {
	app: App;
	title: string;
	body: ReadonlyArray<string>;
	choices: ReadonlyArray<{ key: K; label: string; cls?: ButtonClass }>;
}

export async function openConfirmModal(
	options: ConfirmModalOptions,
): Promise<boolean> {
	const { confirmLabel, confirmClass = "mod-cta", cancelLabel } = options;
	const answer = await openChoiceModal({
		...options,
		choices: [
			{ key: "cancel", label: cancelLabel ?? "Cancel" },
			{ key: "confirm", label: confirmLabel, cls: confirmClass },
		],
	});
	return answer === "confirm";
}

/** Null when dismissed. */
export function openChoiceModal<K extends string>(
	options: ChoiceModalOptions<K>,
): Promise<K | null> {
	return openPromiseModal<K | null>((answer) => {
		const modal = new Modal(options.app);
		modal.modalEl.addClass("obsync-confirm-modal");
		modal.titleEl.setText(options.title);
		for (const paragraph of options.body) {
			modal.contentEl.createEl("p", { text: paragraph });
		}
		const buttons = modal.contentEl.createDiv({ cls: "obsync-modal-buttons" });
		for (const { key, label, cls } of options.choices) {
			const button = new ButtonComponent(buttons)
				.setButtonText(label)
				.onClick(() => {
					answer(key);
					modal.close();
				});
			if (cls === "mod-warning") button.setDestructive();
			else if (cls === "mod-cta") button.setCta();
		}
		return modal;
	}, null);
}
