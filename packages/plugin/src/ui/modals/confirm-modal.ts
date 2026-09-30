import { type App, ButtonComponent, Modal } from "obsidian";

import { openPromiseModal } from "./promise-modal";

export interface ConfirmModalOptions {
	app: App;
	title: string;
	body: ReadonlyArray<string>;
	confirmLabel: string;
	confirmClass?: "mod-cta" | "mod-warning";
	cancelLabel?: string;
}

export function openConfirmModal(
	options: ConfirmModalOptions,
): Promise<boolean> {
	return openPromiseModal<boolean>((answer) => {
		const modal = new Modal(options.app);
		const finish = (confirmed: boolean): void => {
			answer(confirmed);
			modal.close();
		};
		modal.modalEl.addClass("obsync-confirm-modal");
		modal.titleEl.setText(options.title);
		for (const paragraph of options.body) {
			modal.contentEl.createEl("p", { text: paragraph });
		}
		const buttons = modal.contentEl.createDiv({ cls: "obsync-modal-buttons" });
		new ButtonComponent(buttons)
			.setButtonText(options.cancelLabel ?? "Cancel")
			.onClick(() => finish(false));
		const confirm = new ButtonComponent(buttons)
			.setButtonText(options.confirmLabel)
			.onClick(() => finish(true));
		if (options.confirmClass === "mod-warning") confirm.setWarning();
		else confirm.setCta();
		return modal;
	}, false);
}
