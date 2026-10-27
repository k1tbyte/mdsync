import { type App, ButtonComponent, Modal, Setting } from "obsidian";

import type { MdsyncSettings } from "@/core/settings";
import {
	modalFooter,
	modalWarning,
	onEnter,
	openPromiseModal,
	renderModalHead,
} from "@/core/ui";
import { activeStorage, describeStorageTarget } from "@/features/storage";
import type { TransferSection } from "../transfer";

const IMPORT_CONFIRMATION_TEXT = "IMPORT";
const SECTION_NAMES: Record<TransferSection, string> = {
	storage: "storage",
	scope: "what syncs, ignore patterns and the file size limit",
	automation: "automatic sync and file history",
	realtime: "relay and live editing",
};

class SettingsTransferImportModal extends Modal {
	private value = "";

	constructor(
		app: App,
		private readonly answer: (value: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		renderModalHead(this, { icon: "download", title: "Import MDSync setup" });
		contentEl.createEl("p", {
			text: "Paste an MDSync setup link or transfer token encrypted with your passphrase.",
		});

		const textarea = contentEl.createEl("textarea", {
			cls: "mdsync-transfer-url",
		});
		textarea.rows = 6;
		textarea.addEventListener("input", () => {
			this.value = textarea.value;
		});
		onEnter(textarea, () => this.submit());

		const footer = modalFooter(this);
		new ButtonComponent(footer)
			.setButtonText("Cancel")
			.onClick(() => this.close());
		new ButtonComponent(footer)
			.setButtonText("Continue")
			.setCta()
			.onClick(() => this.submit());
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private submit(): void {
		const value = this.value.trim();
		if (!value) return;
		this.answer(value);
		this.close();
	}
}

class SettingsTransferConfirmModal extends Modal {
	private value = "";

	constructor(
		app: App,
		private readonly settings: MdsyncSettings,
		private readonly sections: readonly TransferSection[],
		private readonly answer: (confirmed: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		renderModalHead(this, {
			icon: "alert-triangle",
			title: "Import MDSync setup",
			tone: "danger",
		});
		modalWarning(
			contentEl,
			`Replaces on this device: ${this.sections.map((section) => SECTION_NAMES[section]).join("; ")}. A setting the other device left at its default is reset to the default here.`,
		);
		contentEl.createEl("p", {
			text: "Other sections, local-only display preferences, and passphrase cache settings stay unchanged.",
		});
		if (this.sections.includes("storage")) {
			contentEl.createEl("p", {
				text: describeStorageTarget(activeStorage(this.settings)),
			});
		}
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

		const footer = modalFooter(this);
		new ButtonComponent(footer)
			.setButtonText("Cancel")
			.onClick(() => this.close());
		importButton = new ButtonComponent(footer)
			.setButtonText("Import setup")
			.setDestructive()
			.setDisabled(true)
			.onClick(() => this.submit());
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private submit(): void {
		if (this.value !== IMPORT_CONFIRMATION_TEXT) return;
		this.answer(true);
		this.close();
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
	settings: MdsyncSettings,
	sections: readonly TransferSection[],
): Promise<boolean> {
	return openPromiseModal<boolean>(
		(answer) =>
			new SettingsTransferConfirmModal(app, settings, sections, answer),
		false,
	);
}
