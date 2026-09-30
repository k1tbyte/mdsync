import { type App, type ButtonComponent, Modal, Setting } from "obsidian";

import { activeStorage, type ObsyncSettings } from "@/settings/model";
import { describeStorageTarget } from "@/storage";
import { onEnter } from "@/ui/common";
import { openPromiseModal } from "./promise-modal";

const IMPORT_CONFIRMATION_TEXT = "IMPORT";

class SettingsTransferImportModal extends Modal {
	private readonly resolveValue: (value: string | null) => void;
	private value = "";
	private settled = false;

	constructor(app: App, resolveValue: (value: string | null) => void) {
		super(app);
		this.resolveValue = resolveValue;
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText("Import Obsync setup");
		contentEl.createEl("p", {
			text: "Paste an Obsync setup link or transfer token encrypted with your passphrase.",
		});

		const textarea = contentEl.createEl("textarea", {
			cls: "obsync-transfer-url",
		});
		textarea.rows = 6;
		textarea.addEventListener("input", () => {
			this.value = textarea.value;
		});
		onEnter(textarea, () => this.submit());

		new Setting(contentEl)
			.addButton((button) =>
				button.setButtonText("Cancel").onClick(() => this.cancel()),
			)
			.addButton((button) =>
				button
					.setButtonText("Continue")
					.setCta()
					.onClick(() => this.submit()),
			);
	}

	onClose(): void {
		this.contentEl.empty();
		this.resolveOnce(null);
	}

	private submit(): void {
		const value = this.value.trim();
		if (!value) return;
		this.resolveOnce(value);
		this.close();
	}

	private cancel(): void {
		this.resolveOnce(null);
		this.close();
	}

	private resolveOnce(value: string | null): void {
		if (this.settled) return;
		this.settled = true;
		this.resolveValue(value);
	}
}

class SettingsTransferConfirmModal extends Modal {
	private readonly settings: ObsyncSettings;
	private readonly resolveValue: (confirmed: boolean) => void;
	private settled = false;
	private value = "";

	constructor(
		app: App,
		settings: ObsyncSettings,
		resolveValue: (confirmed: boolean) => void,
	) {
		super(app);
		this.settings = settings;
		this.resolveValue = resolveValue;
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText("Import Obsync setup");
		contentEl.createEl("p", {
			text: "Imported setup updates the included storage and main sync settings on this device.",
		});
		contentEl.createEl("p", {
			text: "Unselected sections, local-only display preferences, and passphrase cache settings stay unchanged.",
		});
		contentEl.createEl("p", {
			text: describeStorageTarget(activeStorage(this.settings)),
		});
		contentEl.createEl("p", {
			text: `Type ${IMPORT_CONFIRMATION_TEXT} to continue.`,
		});

		let importButton: ButtonComponent | null = null;
		new Setting(contentEl).setName("Confirmation").addText((text) => {
			text.inputEl.setAttr("aria-label", "Confirmation");
			text.setPlaceholder(IMPORT_CONFIRMATION_TEXT).onChange((value) => {
				this.value = value.trim();
				importButton?.setDisabled(this.value !== IMPORT_CONFIRMATION_TEXT);
			});
		});

		new Setting(contentEl)
			.addButton((button) =>
				button.setButtonText("Cancel").onClick(() => this.cancel()),
			)
			.addButton((button) => {
				importButton = button;
				button
					.setButtonText("Import setup")
					.setWarning()
					.setDisabled(true)
					.onClick(() => this.submit());
			});
	}

	onClose(): void {
		this.contentEl.empty();
		this.resolveOnce(false);
	}

	private submit(): void {
		if (this.value !== IMPORT_CONFIRMATION_TEXT) return;
		this.resolveOnce(true);
		this.close();
	}

	private cancel(): void {
		this.resolveOnce(false);
		this.close();
	}

	private resolveOnce(confirmed: boolean): void {
		if (this.settled) return;
		this.settled = true;
		this.resolveValue(confirmed);
	}
}

export function askSettingsTransferInput(app: App): Promise<string | null> {
	return openPromiseModal<string | null>(
		(answer) => new SettingsTransferImportModal(app, answer),
		null,
	);
}

export function confirmSettingsTransferImport(
	app: App,
	settings: ObsyncSettings,
): Promise<boolean> {
	return openPromiseModal<boolean>(
		(answer) => new SettingsTransferConfirmModal(app, settings, answer),
		false,
	);
}
