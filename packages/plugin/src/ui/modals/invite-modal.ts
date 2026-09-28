import { type App, Modal, Setting } from "obsidian";

import { folderName } from "@/shared/path";
import type { Invite } from "@/spaces/invite";

/** The participant's side: the password opens the invite, then it gets a folder. */
export class AcceptInviteModal extends Modal {
	private password = "";
	private root = "";

	constructor(
		app: App,
		private readonly unseal: (password: string) => Promise<Invite>,
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
		new Setting(contentEl)
			.setName("Password")
			.setDesc("The password that came with the link.")
			.addText((text) => {
				text.inputEl.type = "password";
				text.onChange((value) => {
					this.password = value.trim();
				});
			});
		const status = contentEl.createEl("p", { cls: "mod-warning" });
		new Setting(contentEl).addButton((button) =>
			button
				.setButtonText("Open invite")
				.setCta()
				.onClick(async () => {
					try {
						this.choose(await this.unseal(this.password));
					} catch {
						status.setText("Wrong password, or the link is damaged.");
					}
				}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private choose(invite: Invite): void {
		const { contentEl } = this;
		contentEl.empty();
		this.root = `Shared/${folderName(invite.name) || invite.id}`;
		contentEl.createEl("p", {
			text: `"${invite.name}" will sync into this folder. Pick a new or empty one.`,
		});
		new Setting(contentEl).setName("Folder").addText((text) =>
			text.setValue(this.root).onChange((value) => {
				this.root = value.trim();
			}),
		);
		const status = contentEl.createEl("p", { cls: "mod-warning" });
		new Setting(contentEl).addButton((button) =>
			button
				.setButtonText("Add shared folder")
				.setCta()
				.onClick(async () => {
					button.setDisabled(true);
					const problem = await this.accept(invite, this.root);
					if (problem === null) {
						this.close();
						return;
					}
					status.setText(problem);
					button.setDisabled(false);
				}),
		);
	}
}
