import { type App, type ButtonComponent, Modal, Setting } from "obsidian";

import { errorMessage } from "@/shared/errors";
import { folderName } from "@/shared/path";
import type { Invite } from "@/spaces";
import { alertLine, onEnter, serial } from "@/ui/common";

const NO_LINK = "Paste the invite link.";
const NO_PASSWORD = "Enter the password.";
const WRONG_PASSWORD = "Wrong password, or the link is damaged or unsupported.";

export class AcceptInviteModal extends Modal {
	private password = "";
	private root = "";

	constructor(
		app: App,
		/** Empty when opened from here, not from the link: it is pasted then. */
		private link: string,
		private readonly unseal: (
			link: string,
			password: string,
		) => Promise<Invite>,
		/** Where this share already is here: the link then replaces its old one. */
		private readonly mountedAt: (invite: Invite) => string | null,
		/** What is wrong with the folder, or null once accepted. */
		private readonly accept: (
			invite: Invite,
			root: string,
		) => Promise<string | null>,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText("Shared folder invite");
		const unlock = serial(async () => {
			if (!this.link || !this.password) {
				status.setText(this.link ? NO_PASSWORD : NO_LINK);
				return;
			}
			let invite: Invite;
			try {
				invite = await this.unseal(this.link, this.password);
			} catch {
				status.setText(WRONG_PASSWORD);
				return;
			}
			this.choose(invite);
		});
		// Obsidian opens a link in the last vault used, not always this one.
		if (!this.link) {
			new Setting(contentEl)
				.setName("Link")
				.setDesc("The obsidian://obsync-share link you were sent.")
				.addText((text) => {
					text.inputEl.setAttr("aria-label", "Link");
					text.onChange((value) => {
						this.link = value.trim();
					});
					onEnter(text.inputEl, unlock);
				});
		}
		new Setting(contentEl)
			.setName("Password")
			.setDesc("The password that came with the link.")
			.addText((text) => {
				text.inputEl.type = "password";
				text.inputEl.setAttr("aria-label", "Password");
				text.onChange((value) => {
					this.password = value.trim();
				});
				onEnter(text.inputEl, unlock);
			});
		const status = alertLine(contentEl);
		new Setting(contentEl).addButton((button) =>
			button.setButtonText("Open invite").setCta().onClick(unlock),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private choose(invite: Invite): void {
		const { contentEl } = this;
		contentEl.empty();
		const mounted = this.mountedAt(invite);
		const role = invite.readOnly
			? "You can read it, not change it."
			: "You can edit it.";
		this.root = mounted ?? `Shared/${folderName(invite.name) || invite.id}`;
		let confirm: ButtonComponent | undefined;
		let folder: HTMLInputElement | undefined;
		const submit = serial(async () => {
			confirm?.setDisabled(true);
			const problem = await this.accept(invite, this.root).catch(errorMessage);
			if (problem === null) {
				this.close();
				return;
			}
			status.setText(problem);
			confirm?.setDisabled(false);
		});
		if (mounted === null) {
			contentEl.createEl("p", {
				text: `"${invite.name}" will sync into this folder. ${role} Pick a new or empty one.`,
			});
			new Setting(contentEl).setName("Folder").addText((text) => {
				folder = text.inputEl;
				text.inputEl.setAttr("aria-label", "Folder");
				text.setValue(this.root).onChange((value) => {
					this.root = value.trim();
				});
				onEnter(text.inputEl, submit);
			});
		} else {
			contentEl.createEl("p", {
				text: `"${invite.name}" is already in "${mounted}": this link replaces the one it syncs with. ${role}`,
			});
		}
		const status = alertLine(contentEl);
		new Setting(contentEl).addButton((button) => {
			confirm = button
				.setButtonText(mounted === null ? "Add shared folder" : "Use this link")
				.setCta()
				.onClick(submit);
			(folder ?? button.buttonEl).focus();
		});
	}
}
