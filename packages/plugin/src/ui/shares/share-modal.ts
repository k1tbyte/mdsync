import { type App, Modal, Setting } from "obsidian";

import type { Person } from "@/presence/people";
import { errorMessage } from "@/shared/errors";
import type { Participant } from "@/storage";
import { renderAvatar } from "@/ui/live/avatars";
import type { CreatedInvite } from "./invite-action";
import { renderInviteForm } from "./invite-section";
import { pauseToggle } from "./pause-toggle";
import { type ShareRow, shareRows } from "./share-people";

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
	here(): Person[];
	/** Why the relay cannot show who is here; null when it can. */
	note(): string | null;
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

/** One place for a shared folder: its people, invites, pause, stop. */
export class ShareModal extends Modal {
	private participants: Participant[] | null = null;
	private failure: string | null = null;
	private revoking = false;
	private redraw = (): void => {};
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
		section(contentEl, "People");
		const list = contentEl.createDiv({ cls: "obsync-share-access" });
		this.redraw = () => this.renderPeople(list);
		this.unsubscribe = share.subscribe(this.redraw);
		this.redraw();
		void this.load();
		if (share.access) {
			section(contentEl, "Invite");
			renderInviteForm(contentEl, share.access.invite, () => void this.load());
		}
		this.renderFooter();
	}

	onClose(): void {
		this.unsubscribe?.();
		this.contentEl.empty();
		this.share.onClosed?.();
	}

	private async load(): Promise<void> {
		const { access } = this.share;
		if (!access) return;
		try {
			this.participants = await access.people();
			this.failure = null;
		} catch (err) {
			this.failure = errorMessage(err);
		}
		this.redraw();
	}

	private renderPeople(list: HTMLElement): void {
		list.empty();
		const rows = shareRows(this.share.here(), this.participants);
		const note = this.noteOf(rows);
		if (note) {
			list.createEl("p", { cls: "setting-item-description", text: note });
		}
		for (const row of rows) this.renderRow(list, row);
	}

	private noteOf(rows: readonly ShareRow[]): string | null {
		const { share } = this;
		if (this.failure) return this.failure;
		if (share.access && this.participants === null) return "Loading…";
		const empty = share.access
			? "Nobody else can open this folder yet."
			: "Nobody else is here now.";
		return share.note() ?? (rows.length > 0 ? null : empty);
	}

	private renderRow(list: HTMLElement, row: ShareRow): void {
		const { share } = this;
		const setting = new Setting(list).setName(named(row)).setDesc(row.detail);
		const note = row.person?.note ?? null;
		if (note !== null) {
			setting.addExtraButton((button) =>
				button
					.setIcon("file-text")
					.setTooltip(`Open ${note}`)
					.onClick(() => {
						this.close();
						share.openNote(note);
					}),
			);
		}
		const { access } = share;
		const { participant } = row;
		if (!access || !participant) return;
		setting.addButton((button) =>
			button
				.setButtonText("Revoke")
				.setWarning()
				.onClick(() => this.revoke(access, participant)),
		);
	}

	private async revoke(
		access: ShareAccess,
		participant: Participant,
	): Promise<void> {
		if (this.revoking) return;
		this.revoking = true;
		try {
			if (await access.revoke(participant)) await this.load();
		} catch (err) {
			this.failure = errorMessage(err);
			this.redraw();
		} finally {
			this.revoking = false;
		}
	}

	private renderFooter(): void {
		const { share } = this;
		const footer = new Setting(this.contentEl);
		footer.settingEl.addClass("obsync-share-footer");
		const { paused } = share;
		if (paused !== null) {
			footer.addButton((button) => {
				const show = (now: boolean) =>
					button.setButtonText(
						now ? "Resume on this device" : "Pause on this device",
					);
				show(paused);
				button
					.setTooltip("Only this device; the others keep syncing it.")
					.onClick(pauseToggle(paused, (next) => share.setPaused(next), show));
			});
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

function named({ key, name, person }: ShareRow): DocumentFragment {
	const fragment = createFragment();
	renderAvatar(fragment, { key, name, idle: person?.idle ?? false });
	fragment.createSpan({ text: name });
	return fragment;
}
