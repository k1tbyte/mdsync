import { type App, Modal, Setting } from "obsidian";

import type { Person } from "@/presence/people";
import { errorMessage } from "@/shared/errors";
import type { Participant } from "@/storage";
import { renderAvatar } from "@/ui/avatars";

export interface CreatedInvite {
	link: string;
	password: string;
}

/** The owner's side of a share: who holds access, and new invites. */
export interface ShareAccess {
	people(): Promise<Participant[]>;
	/** False when the owner backed out. */
	revoke(person: Participant): Promise<boolean>;
	invite(person: string, readOnly: boolean): Promise<CreatedInvite>;
}

export interface ShareWindow {
	name: string;
	/** Whose it is and where, in a sentence. */
	summary: string;
	/** Null where no relay carries the share, so nobody can be seen. */
	here(): Person[] | null;
	subscribe(listener: () => void): () => void;
	openNote(path: string): void;
	/** Null for a participant, or an owner without a relay. */
	access: ShareAccess | null;
	/** Null where the share cannot sync here at all. */
	paused: boolean | null;
	setPaused(paused: boolean): Promise<void>;
	closeLabel: string;
	/** True once the share is closed. */
	close(): Promise<boolean>;
	/** The window went away: what it changed may need redrawing. */
	onClosed?(): void;
}

/** One place for a shared folder: who is here, who has access, invites, pause, stop. */
export class ShareModal extends Modal {
	private unsubscribe: (() => void) | null = null;

	constructor(
		app: App,
		private readonly share: ShareWindow,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, share } = this;
		this.modalEl.addClass("obsync-share-modal");
		this.titleEl.setText(`Sharing "${share.name}"`);
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: share.summary,
		});
		section(contentEl, "Here now");
		const here = contentEl.createDiv();
		this.renderHere(here);
		this.unsubscribe = share.subscribe(() => this.renderHere(here));
		if (share.access) {
			const reload = this.renderAccess(share.access);
			this.renderInvite(share.access, reload);
		}
		this.renderFooter();
	}

	onClose(): void {
		this.unsubscribe?.();
		this.contentEl.empty();
		this.share.onClosed?.();
	}

	private renderHere(el: HTMLElement): void {
		el.empty();
		const people = this.share.here();
		if (people === null || people.length === 0) {
			el.createEl("p", {
				cls: "setting-item-description",
				text:
					people === null
						? "Set up the relay to see who is here."
						: "Nobody else is here now.",
			});
			return;
		}
		for (const person of people) {
			const row = new Setting(el)
				.setName(named(person))
				.setDesc(whereOf(person));
			const { note } = person;
			if (note === null) continue;
			row.addExtraButton((button) =>
				button
					.setIcon("file-text")
					.setTooltip(`Open ${note}`)
					.onClick(() => {
						this.close();
						this.share.openNote(note);
					}),
			);
		}
	}

	/** Returns the reload, for an invite that changed the list. */
	private renderAccess(access: ShareAccess): () => Promise<void> {
		section(this.contentEl, "People with access");
		const list = this.contentEl.createDiv({ cls: "obsync-share-access" });
		let busy = false;
		const load = async (): Promise<void> => {
			list.empty();
			const status = list.createEl("p", {
				cls: "setting-item-description",
				text: "Loading…",
			});
			let people: Participant[];
			try {
				people = await access.people();
			} catch (err) {
				status.setText(errorMessage(err));
				return;
			}
			status.setText(
				people.length === 0
					? "Nobody else can open this folder yet."
					: "Revoking ends their access; their copy of the files stays with them.",
			);
			const online = new Set(this.share.here()?.map(({ key }) => key));
			for (const person of people) {
				const role = person.readOnly ? "Read-only" : "Can edit";
				new Setting(list)
					.setName(named({ key: person.id, name: person.label || "Unnamed" }))
					.setDesc(online.has(person.id) ? `${role}, here now` : role)
					.addButton((button) =>
						button
							.setButtonText("Revoke")
							.setWarning()
							.onClick(async () => {
								if (busy) return;
								busy = true;
								try {
									if (await access.revoke(person)) await load();
								} catch (err) {
									status.setText(errorMessage(err));
								} finally {
									busy = false;
								}
							}),
					);
			}
		};
		void load();
		return load;
	}

	private renderInvite(access: ShareAccess, reload: () => Promise<void>): void {
		const { contentEl } = this;
		let person = "";
		let readOnly = false;
		section(contentEl, "Invite");
		new Setting(contentEl)
			.setName("Name")
			.setDesc(
				"Who the invite is for. Inviting the same name again replaces their earlier link.",
			)
			.addText((text) =>
				text.onChange((value) => {
					person = value.trim();
				}),
			);
		new Setting(contentEl).setName("Read-only").addToggle((toggle) =>
			toggle.onChange((value) => {
				readOnly = value;
			}),
		);
		const status = contentEl.createEl("p", { cls: "mod-warning" });
		const button = new Setting(contentEl);
		const created = contentEl.createDiv();
		button.addButton((create) =>
			create
				.setButtonText("Create invite")
				.setCta()
				.onClick(async () => {
					status.setText(person ? "" : "Enter who it is for.");
					if (!person) return;
					create.setDisabled(true);
					try {
						showInvite(created, await access.invite(person, readOnly));
						void reload();
					} catch (err) {
						status.setText(errorMessage(err));
					} finally {
						create.setDisabled(false);
					}
				}),
		);
	}

	private renderFooter(): void {
		const { share } = this;
		const footer = new Setting(this.contentEl);
		footer.settingEl.addClass("obsync-share-footer");
		let { paused } = share;
		if (paused !== null) {
			const label = () =>
				paused ? "Resume on this device" : "Pause on this device";
			footer.addButton((button) =>
				button
					.setButtonText(label())
					.setTooltip("Only this device; the others keep syncing it.")
					.onClick(async () => {
						paused = !paused;
						await share.setPaused(paused);
						button.setButtonText(label());
					}),
			);
		}
		footer.addButton((button) =>
			button
				.setButtonText(share.closeLabel)
				.setWarning()
				.onClick(async () => {
					if (await share.close()) this.close();
				}),
		);
	}
}

function section(parent: HTMLElement, title: string): void {
	parent.createDiv({ cls: "obsync-share-section", text: title });
}

function named(person: Pick<Person, "key" | "name">): DocumentFragment {
	const name = createFragment();
	renderAvatar(name, { ...person, idle: false });
	name.createSpan({ text: person.name });
	return name;
}

function whereOf(person: Person): string {
	if (person.idle) return "Away";
	return person.note === null
		? "Online, no note of it open"
		: `In ${person.note.slice(person.note.lastIndexOf("/") + 1)}`;
}

function showInvite(el: HTMLElement, invite: CreatedInvite): void {
	el.empty();
	el.createEl("p", {
		cls: "setting-item-description",
		text: "Send the link and the password separately, for example the link by email and the password by message.",
	});
	copyable(el, "Link", invite.link);
	copyable(el, "Password", invite.password);
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
