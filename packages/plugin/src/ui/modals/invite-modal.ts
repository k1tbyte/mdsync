import { type App, type ButtonComponent, Modal, Setting } from "obsidian";

import { errorMessage } from "@/shared/errors";
import { folderName } from "@/shared/path";
import type { Invite } from "@/spaces/invite";
import { alertLine } from "@/ui/common/alert-line";
import { onEnter, serial } from "@/ui/common/enter-key";

const NO_PASSWORD = "Enter the password.";
const WRONG_PASSWORD = "Wrong password, or the link is damaged or unsupported.";

/** The participant's side: the password opens the invite, then it gets a folder. */
export class AcceptInviteModal extends Modal {
	private password = "";
	private root = "";

	constructor(
		app: App,
		private readonly unseal: (password: string) => Promise<Invite>,
		/** The folder of this share's copy already here: the link then replaces its old one. */
		private readonly mountedAt: (invite: Invite) => string | null,
		/** Resolves to what is wrong with `root`, or null once accepted. */
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
			if (!this.password) {
				status.setText(NO_PASSWORD);
				return;
			}
			let invite: Invite;
			try {
				invite = await this.unseal(this.password);
			} catch {
				status.setText(WRONG_PASSWORD);
				return;
			}
			this.choose(invite);
		});
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
				text: `"${invite.name}" will sync into this folder. Pick a new or empty one.`,
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
				text: `"${invite.name}" is already in "${mounted}": this link replaces the one it syncs with.`,
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
