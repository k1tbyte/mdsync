import { type App, ButtonComponent, Modal, Setting } from "obsidian";
import {
	modalFooter,
	modalWarning,
	onEnter,
	openPromiseModal,
	renderModalHead,
} from "@/core/ui";

const CONFIRMATION_TEXT = "RESET";

export interface RemoteResetTarget {
	description: string;
}

class RemoteResetModal extends Modal {
	private value = "";

	constructor(
		app: App,
		private readonly target: RemoteResetTarget,
		private readonly answer: (confirmed: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		renderModalHead(this, {
			icon: "alert-triangle",
			title: "Reset remote storage",
			tone: "danger",
		});
		modalWarning(
			contentEl,
			"This deletes the remote MDSync manifest, file contents, version history and pins on the configured backend. Local vault files are not deleted.",
		);
		contentEl.createEl("p", { text: this.target.description });
		contentEl.createEl("p", { text: `Type ${CONFIRMATION_TEXT} to continue.` });

		let resetButton: ButtonComponent | null = null;
		new Setting(contentEl).setName("Confirmation").addText((text) => {
			text.inputEl.setAttr("aria-label", "Confirmation");
			text.setPlaceholder(CONFIRMATION_TEXT).onChange((value) => {
				this.value = value.trim();
				resetButton?.setDisabled(this.value !== CONFIRMATION_TEXT);
			});
			onEnter(text.inputEl, () => this.submit());
		});

		const footer = modalFooter(this);
		new ButtonComponent(footer)
			.setButtonText("Cancel")
			.onClick(() => this.close());
		resetButton = new ButtonComponent(footer)
			.setButtonText("Reset remote")
			.setDestructive()
			.setDisabled(true)
			.onClick(() => this.submit());
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private submit(): void {
		if (this.value !== CONFIRMATION_TEXT) return;
		this.answer(true);
		this.close();
	}
}

export function confirmRemoteReset(
	app: App,
	target: RemoteResetTarget,
): Promise<boolean> {
	return openPromiseModal<boolean>(
		(answer) => new RemoteResetModal(app, target, answer),
		false,
	);
}
