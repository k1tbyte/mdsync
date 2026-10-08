import { LINK_MAX_TTL_S } from "@mdsync/protocol";
import {
	ButtonComponent,
	Modal,
	Setting,
	type TextComponent,
	type TFile,
} from "obsidian";

import {
	DEFAULT_EXPIRY,
	DEFAULT_VIEWS,
	EXPIRY_CHOICES,
	expiryLine,
	type LinkRecord,
	leftOutText,
	linkError,
	PICK_DATE,
	previewLink,
	publishLink,
	resolveExpiry,
	type Snapshot,
	VIEW_CHOICES,
} from "@/links";
import type { PluginHost } from "@/plugin/host";
import { invitePassword } from "@/spaces";
import { alertLine, copyable, serial } from "@/ui/common";
import { renderPreviewFrame } from "./preview-frame";

const MIN_PASSPHRASE = 8;
const MS_PER_S = 1000;
const MINUTE_MS = 60 * MS_PER_S;
const DAY_MS = 24 * 60 * MINUTE_MS;
const LOCAL_DATETIME_LENGTH = 16;

const UNFINISHED =
	"Part of the note was still drawing when this copy was taken: check the preview.";

const INTRO =
	"Anyone with the link can read a copy of this note as it is now. It is encrypted on this device and kept on your relay, which cannot read it. Links to other notes, embedded notes and files other than images are left out.";

/** Publishes one note as a link and shows it once. */
export class ShareLinkModal extends Modal {
	private expiry: string = DEFAULT_EXPIRY;
	private pickedDate = "";
	private views: string = DEFAULT_VIEWS;
	private passphrase = "";
	private images = true;
	private showName = true;
	private closed = false;
	private uploading = false;
	private previews = 0;
	/** What the owner is looking at: the copy that goes out. Null while it is being made. */
	private snapshot: Snapshot | null = null;
	private passphraseField: TextComponent | null = null;
	private createButton: ButtonComponent | null = null;

	constructor(
		private readonly plugin: PluginHost,
		private readonly file: TFile,
	) {
		super(plugin.app);
	}

	onOpen(): void {
		this.modalEl.addClass("mdsync-link-modal");
		this.titleEl.setText(`Share a link to "${this.file.basename}"`);
		this.renderForm();
	}

	/** The passphrase is shown only in the result, so a link being made is waited for. */
	close(): void {
		if (!this.uploading) super.close();
	}

	onClose(): void {
		this.closed = true;
		this.contentEl.empty();
	}

	private renderForm(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("p", { cls: "setting-item-description", text: INTRO });
		this.renderExpiry(contentEl);
		new Setting(contentEl)
			.setName("Views")
			.setDesc("The link stops working after this many openings.")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(optionsOf(VIEW_CHOICES))
					.setValue(this.views)
					.onChange((value) => {
						this.views = value;
					}),
			);
		new Setting(contentEl)
			.setName("Passphrase")
			.setDesc(
				"Optional. Whoever opens the link has to type it. Send it by a different route than the link.",
			)
			.addText((text) => {
				text.setPlaceholder("None").setValue(this.passphrase);
				text.inputEl.setAttr("aria-label", "Passphrase");
				text.onChange((value) => {
					this.passphrase = value.trim();
				});
				this.passphraseField = text;
			})
			.addButton((button) =>
				button.setButtonText("Generate").onClick(() => {
					this.passphrase = invitePassword();
					this.passphraseField?.setValue(this.passphrase);
				}),
			);
		const preview = contentEl.createDiv({ cls: "mdsync-link-preview" });
		new Setting(contentEl)
			.setName("Include images")
			.setDesc("Images from your vault are embedded in the link.")
			.addToggle((toggle) =>
				toggle.setValue(this.images).onChange((value) => {
					this.images = value;
					void this.refreshPreview(preview);
				}),
			);
		new Setting(contentEl)
			.setName("Show the note's name")
			.setDesc("Off, the page opens without a title.")
			.addToggle((toggle) =>
				toggle.setValue(this.showName).onChange((value) => {
					this.showName = value;
				}),
			);
		const failure = alertLine(contentEl);
		const buttons = contentEl.createDiv({ cls: "mdsync-modal-buttons" });
		new ButtonComponent(buttons)
			.setButtonText("Cancel")
			.onClick(() => this.close());
		const create = new ButtonComponent(buttons)
			.setButtonText("Create link")
			.setCta();
		this.createButton = create;
		create.onClick(
			serial(async () => {
				failure.setText("");
				const expiry = resolveExpiry(this.expiry, this.pickedDate, Date.now());
				if (!expiry.ok) {
					failure.setText(expiry.reason);
					return;
				}
				if (this.passphrase && this.passphrase.length < MIN_PASSPHRASE) {
					failure.setText(
						`Use at least ${MIN_PASSPHRASE} characters, or press Generate.`,
					);
					return;
				}
				// Only what was shown goes out, and what was typed now: the fields stay editable meanwhile.
				const { snapshot } = this;
				const passphrase = this.passphrase;
				if (!snapshot) return;
				this.uploading = true;
				this.syncCreate();
				try {
					const record = await this.create(passphrase, snapshot, expiry.ttl);
					this.renderResult(record, passphrase);
				} catch (err) {
					failure.setText(linkError(err).message);
				} finally {
					this.uploading = false;
					this.syncCreate();
				}
			}),
		);
		void this.refreshPreview(preview);
	}

	private renderExpiry(parent: HTMLElement): void {
		const setting = new Setting(parent).setName("Expires");
		this.pickedDate = localDateTime(Date.now() + DAY_MS);
		let dateField: TextComponent;
		const update = (): void => {
			const nowMs = Date.now();
			dateField.inputEl.toggle(this.expiry === PICK_DATE);
			dateField.inputEl.min = localDateTime(
				Math.ceil((nowMs + MINUTE_MS) / MINUTE_MS) * MINUTE_MS,
			);
			dateField.inputEl.max = localDateTime(nowMs + LINK_MAX_TTL_S * MS_PER_S);
			const expiry = resolveExpiry(this.expiry, this.pickedDate, nowMs);
			setting.setDesc(expiry.ok ? expiryLine(expiry.expires) : expiry.reason);
		};
		setting
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(optionsOf(EXPIRY_CHOICES))
					.setValue(this.expiry)
					.onChange((value) => {
						this.expiry = value;
						update();
					}),
			)
			.addText((text) => {
				dateField = text;
				text.inputEl.type = "datetime-local";
				text.inputEl.setAttr("aria-label", "Expiry date and time");
				text.setValue(this.pickedDate).onChange((value) => {
					this.pickedDate = value;
					update();
				});
			});
		update();
	}

	private create(
		passphrase: string,
		snapshot: Snapshot,
		ttl: number | null,
	): Promise<LinkRecord> {
		const views = VIEW_CHOICES.find(({ key }) => key === this.views);
		return publishLink(
			this.plugin,
			this.file,
			{
				ttl,
				maxViews: views?.views ?? null,
				passphrase: passphrase || null,
				showTitle: this.showName,
			},
			snapshot,
		);
	}

	/** Creating waits for it: what goes out is what was shown. */
	private async refreshPreview(pane: HTMLElement): Promise<void> {
		const run = ++this.previews;
		this.snapshot = null;
		this.syncCreate();
		pane.empty();
		const line = pane.createEl("p", {
			cls: "setting-item-description",
			text: "Checking what the link will contain…",
		});
		try {
			const snapshot = await previewLink(this.plugin, this.file, this.images);
			if (run !== this.previews || this.closed) return;
			this.snapshot = snapshot;
			const left = leftOutText(snapshot.left);
			line.setText(
				[
					left ? `Left out of the link: ${left}.` : "",
					snapshot.complete ? "" : UNFINISHED,
				]
					.filter(Boolean)
					.join(" "),
			);
			const details = pane.createEl("details");
			details.createEl("summary", { text: "Preview" });
			renderPreviewFrame(details, snapshot.html);
		} catch (err) {
			if (run !== this.previews || this.closed) return;
			line.setText(
				`Could not check the note: ${linkError(err).message} Close this window and try again.`,
			);
		}
		this.syncCreate();
	}

	private syncCreate(): void {
		this.createButton?.setDisabled(this.snapshot === null || this.uploading);
	}

	private renderResult(record: LinkRecord, passphrase: string): void {
		const { contentEl } = this;
		contentEl.empty();
		this.titleEl.setText("Link created");
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: passphrase
				? "Send the link and the passphrase by different routes. The passphrase is not saved: you will not see it again. The link stays listed under Manage share links."
				: "Anyone who gets this link can read the note. It stays listed under Manage share links.",
		});
		copyable(contentEl, "Link", record.url);
		if (passphrase) copyable(contentEl, "Passphrase", passphrase);
		const buttons = contentEl.createDiv({ cls: "mdsync-modal-buttons" });
		new ButtonComponent(buttons)
			.setButtonText("Done")
			.setCta()
			.onClick(() => this.close());
	}
}

function localDateTime(ms: number): string {
	const date = new Date(ms);
	return new Date(ms - date.getTimezoneOffset() * MINUTE_MS)
		.toISOString()
		.slice(0, LOCAL_DATETIME_LENGTH);
}

function optionsOf(
	choices: ReadonlyArray<{ key: string; label: string }>,
): Record<string, string> {
	return Object.fromEntries(choices.map(({ key, label }) => [key, label]));
}
