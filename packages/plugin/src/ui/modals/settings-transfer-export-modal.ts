import { type App, Modal, Setting } from "obsidian";
import * as QRCode from "qrcode";

import {
	DEFAULT_SETTINGS_TRANSFER_EXPORT_OPTIONS,
	ESettingsTransferStorageMode,
	hasSettingsTransferSelection,
	type SettingsTransferExportOptions,
	type SettingsTransferPackage,
} from "@/settings/transfer";
import { errorMessage } from "@/shared";
import { focusKey, renderKeepingFocus, runWithNotice } from "@/ui/common";

const QR_SIZE = 320;

const QR_ERROR_CORRECTION = "L" as const;

interface SettingsTransferExportModalOptions {
	createPackage: (
		options: SettingsTransferExportOptions,
	) => Promise<SettingsTransferPackage | null>;
}

const EVERYTHING: SettingsTransferExportOptions = {
	storageMode: ESettingsTransferStorageMode.All,
	includeSyncScope: true,
	includeAutomation: true,
	includeRealtime: true,
};

interface ExportToggle {
	name: string;
	desc: string;
	get: (options: SettingsTransferExportOptions) => boolean;
	set: (
		value: boolean,
		options: SettingsTransferExportOptions,
	) => SettingsTransferExportOptions;
	/** Disabled while the value is implied by another toggle. */
	locked?: (options: SettingsTransferExportOptions) => boolean;
}

/** True when the selection already covers everything transferable. */
function isEverything(options: SettingsTransferExportOptions): boolean {
	return (
		options.storageMode === ESettingsTransferStorageMode.All &&
		options.includeSyncScope &&
		options.includeAutomation &&
		options.includeRealtime
	);
}

const EXPORT_TOGGLES: ReadonlyArray<ExportToggle> = [
	{
		name: "Entire transferable config",
		desc: "Includes all saved storage setups plus sync scope, automation, history, and live sync settings.",
		get: isEverything,
		set: (value, options) =>
			value
				? { ...EVERYTHING }
				: { ...options, storageMode: ESettingsTransferStorageMode.Active },
	},
	{
		name: "Current storage setup",
		desc: "Transfer credentials and connection details for the currently selected backend so sync works right away.",
		get: (o) => o.storageMode !== ESettingsTransferStorageMode.None,
		locked: (o) => o.storageMode === ESettingsTransferStorageMode.All,
		set: (value, o) => ({
			...o,
			storageMode: value
				? ESettingsTransferStorageMode.Active
				: ESettingsTransferStorageMode.None,
		}),
	},
	{
		name: "All saved storage setups",
		desc: "Also include every saved backend configuration, not just the currently selected one.",
		get: (o) => o.storageMode === ESettingsTransferStorageMode.All,
		set: (value, o) => ({
			...o,
			storageMode: value
				? ESettingsTransferStorageMode.All
				: o.storageMode === ESettingsTransferStorageMode.None
					? ESettingsTransferStorageMode.None
					: ESettingsTransferStorageMode.Active,
		}),
	},
	{
		name: "Sync scope and ignore rules",
		desc: "Include Obsidian sync categories, device-local ignore patterns, and the max file size limit.",
		get: (o) => o.includeSyncScope,
		set: (value, o) => ({ ...o, includeSyncScope: value }),
	},
	{
		name: "Automation and history",
		desc: "Include autosync, queued push, file history, and related automation settings.",
		get: (o) => o.includeAutomation,
		set: (value, o) => ({ ...o, includeAutomation: value }),
	},
	{
		name: "Live sync relay settings",
		desc: "Include the real-time sync toggle, relay URL, and relay token.",
		get: (o) => o.includeRealtime,
		set: (value, o) => ({ ...o, includeRealtime: value }),
	},
];

class SettingsTransferExportModal extends Modal {
	private readonly createPackage: SettingsTransferExportModalOptions["createPackage"];
	private options: SettingsTransferExportOptions = {
		...DEFAULT_SETTINGS_TRANSFER_EXPORT_OPTIONS,
	};
	private exportPackage: SettingsTransferPackage | null = null;
	private note = "Select what to export, then generate the encrypted link.";
	private generating = false;

	constructor(app: App, options: SettingsTransferExportModalOptions) {
		super(app);
		this.createPackage = options.createPackage;
	}

	onOpen(): void {
		const { titleEl } = this;
		titleEl.setText("Export MDSync setup");
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		renderKeepingFocus(this.contentEl, () => this.draw());
	}

	private draw(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("p", {
			text: "Generate an encrypted setup link for another device. The same MDSync passphrase is required to import it.",
		});
		contentEl.createEl("p", {
			text: "Local-only display preferences and passphrase cache settings are never transferred.",
		});
		contentEl.createEl("h3", { text: "What to export" });

		for (const toggle of EXPORT_TOGGLES) {
			new Setting(contentEl)
				.setName(toggle.name)
				.setDesc(toggle.desc)
				.addToggle((control) => {
					focusKey(control.toggleEl, toggle.name);
					control
						.setValue(toggle.get(this.options))
						.setDisabled(toggle.locked?.(this.options) ?? false)
						.onChange((value) => {
							this.options = toggle.set(value, this.options);
							this.markSelectionChanged();
						});
				});
		}

		contentEl.createEl("h3", { text: "Export preview" });
		contentEl.createEl("p", { text: this.note });

		if (this.exportPackage) {
			contentEl.createEl("p", {
				text: `Transfer size: ${this.exportPackage.byteLength.toLocaleString()} bytes.`,
			});

			if (this.exportPackage.qrEligible) {
				const canvas = contentEl.createEl("canvas");
				canvas.addClass("mdsync-transfer-qr");
				void QRCode.toCanvas(canvas, this.exportPackage.url, {
					errorCorrectionLevel: QR_ERROR_CORRECTION,
					margin: 1,
					width: QR_SIZE,
				}).catch(() => {
					canvas.remove();
					contentEl.createEl("p", {
						text: "QR code unavailable on this platform. Use the link below.",
						cls: "mdsync-transfer-qr-fallback",
					});
				});
			} else {
				contentEl.createEl("p", {
					text: "This export is too large for a reliable QR code. Use the encrypted link below.",
					cls: "mdsync-transfer-qr-fallback",
				});
			}

			const textarea = contentEl.createEl("textarea", {
				cls: "mdsync-transfer-url",
			});
			textarea.value = this.exportPackage.url;
			textarea.rows = 4;
			textarea.readOnly = true;
		}

		const footer = new Setting(contentEl);
		footer.settingEl.addClass("mdsync-button-row");
		footer
			.addButton((button) =>
				button
					.setButtonText(
						this.exportPackage ? "Refresh export" : "Generate export",
					)
					.setCta()
					.setDisabled(
						this.generating || !hasSettingsTransferSelection(this.options),
					)
					.onClick(() => void this.generateExport()),
			)
			.addButton((button) =>
				button
					.setButtonText("Copy link")
					.setDisabled(this.exportPackage === null)
					.onClick(() => void this.copyLink()),
			)
			.addButton((button) =>
				button.setButtonText("Close").onClick(() => this.close()),
			);
	}

	private markSelectionChanged(): void {
		this.exportPackage = null;
		this.note = "Selection changed. Generate a new encrypted link.";
		this.render();
	}

	private async generateExport(): Promise<void> {
		if (this.generating || !hasSettingsTransferSelection(this.options)) return;
		this.generating = true;
		this.note = "Generating encrypted transfer...";
		this.render();
		const asked = this.options;
		try {
			const exportPackage = await this.createPackage(asked);
			// Toggled meanwhile: the link would carry what the toggles no longer show.
			if (this.options !== asked) return;
			if (!exportPackage) {
				this.exportPackage = null;
				this.note = "Export canceled.";
				return;
			}
			this.exportPackage = exportPackage;
			this.note = exportPackage.qrEligible
				? "QR code ready. Import it on the other device with the same MDSync passphrase."
				: "Link ready. The QR code was skipped because this export is too large to scan reliably.";
		} catch (err) {
			this.exportPackage = null;
			this.note = errorMessage(err);
		} finally {
			this.generating = false;
			this.render();
		}
	}

	private async copyLink(): Promise<void> {
		const url = this.exportPackage?.url;
		if (!url) return;
		await runWithNotice(
			() => navigator.clipboard.writeText(url),
			"Transfer link copied.",
			"Could not copy the link",
		);
	}
}

export function showSettingsTransferExport(
	app: App,
	options: SettingsTransferExportModalOptions,
): void {
	new SettingsTransferExportModal(app, options).open();
}
