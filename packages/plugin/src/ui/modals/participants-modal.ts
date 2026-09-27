import { type App, Modal, Setting } from "obsidian";

import { errorMessage } from "@/shared/errors";
import type { Participant } from "@/storage";

/** The owner's list of who can open a share, as the broker knows it. */
export class ParticipantsModal extends Modal {
	/** One revoke at a time: each re-renders the list, and two would interleave. */
	private busy = false;

	constructor(
		app: App,
		private readonly shareName: string,
		private readonly load: () => Promise<Participant[]>,
		/** False when the owner backed out. */
		private readonly revoke: (person: Participant) => Promise<boolean>,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(`People in "${this.shareName}"`);
		void this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async render(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		const status = contentEl.createEl("p", { text: "Loading…" });
		let people: Participant[];
		try {
			people = await this.load();
		} catch (err) {
			status.setText(errorMessage(err));
			return;
		}
		status.setText(
			people.length === 0
				? "Nobody else can open this folder."
				: "Revoking ends their access; their copy of the files stays with them.",
		);
		for (const person of people) {
			new Setting(contentEl)
				.setName(person.label || "Unnamed")
				.setDesc(person.readOnly ? "Read-only" : "Can edit")
				.addButton((button) =>
					button
						.setButtonText("Revoke")
						.setWarning()
						.onClick(async () => {
							if (this.busy) return;
							this.busy = true;
							button.setDisabled(true);
							try {
								if (await this.revoke(person)) await this.render();
								else button.setDisabled(false);
							} catch (err) {
								status.setText(errorMessage(err));
								button.setDisabled(false);
							} finally {
								this.busy = false;
							}
						}),
				);
		}
	}
}
