import { type App, Modal, Setting } from "obsidian";

import { errorMessage } from "@/shared/errors";
import { folderName } from "@/shared/path";
import type { Invite } from "@/spaces/invite";

export interface CreatedInvite {
	link: string;
	password: string;
}

/** The owner's side: who the invite is for, then its link and password. */
export class InviteModal extends Modal {
	private person = "";
	private readOnly = false;

	constructor(
		app: App,
		private readonly shareName: string,
		private readonly create: (
			person: string,
			readOnly: boolean,
		) => Promise<CreatedInvite>,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText(`Invite to "${this.shareName}"`);
		new Setting(contentEl)
			.setName("Name")
			.setDesc(
				"Who the invite is for. Inviting the same name again replaces their previous link.",
			)
			.addText((text) =>
				text.onChange((value) => {
					this.person = value.trim();
				}),
			);
		new Setting(contentEl).setName("Read-only").addToggle((toggle) =>
			toggle.onChange((value) => {
				this.readOnly = value;
			}),
		);
		const status = contentEl.createEl("p", { cls: "mod-warning" });
		new Setting(contentEl).addButton((button) =>
			button
				.setButtonText("Create invite")
				.setCta()
				.onClick(async () => {
					if (!this.person) {
						status.setText("Enter who it is for.");
						return;
					}
					button.setDisabled(true);
					try {
						this.show(await this.create(this.person, this.readOnly));
					} catch (err) {
						status.setText(errorMessage(err));
						button.setDisabled(false);
					}
				}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private show(invite: CreatedInvite): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("p", {
			text: "Send the link and the password separately, for example the link by email and the password by message.",
		});
		copyable(contentEl, "Link", invite.link);
		copyable(contentEl, "Password", invite.password);
	}
}

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

function copyable(el: HTMLElement, name: string, value: string): void {
	new Setting(el)
		.setName(name)
		.addText((text) => {
			text.setValue(value);
			text.inputEl.readOnly = true;
		})
		.addExtraButton((button) =>
			button
				.setIcon("copy")
				.setTooltip(`Copy ${name.toLowerCase()}`)
				.onClick(() => void navigator.clipboard.writeText(value)),
		);
}
