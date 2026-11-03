import { type App, ButtonComponent, Modal } from "obsidian";

import type { MdsyncSettings } from "@/core/settings";
import {
	modalFooter,
	onEnter,
	openConfirmModal,
	openPromiseModal,
	renderModalHead,
} from "@/core/ui";
import { activeStorage, describeStorageTarget } from "@/features/storage";
import type { TransferSection } from "../transfer";

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
	return openConfirmModal({
		app,
		title: "Import MDSync setup",
		warning: `Replaces on this device: ${sections.map((section) => SECTION_NAMES[section]).join("; ")}. A setting the other device left at its default is reset to the default here.`,
		body: [
			"Other sections, local-only display preferences, and passphrase cache settings stay unchanged.",
			...(sections.includes("storage")
				? [describeStorageTarget(activeStorage(settings))]
				: []),
		],
		typed: "IMPORT",
		confirmLabel: "Import setup",
		confirmClass: "mod-warning",
	});
}
