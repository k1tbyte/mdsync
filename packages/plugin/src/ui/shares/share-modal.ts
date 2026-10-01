import { Modal, Setting } from "obsidian";

import type { PluginHost } from "@/plugin/host";
import { isRelayConfigured } from "@/settings/model";
import { errorMessage } from "@/shared/errors";
import type { PauseKind } from "@/spaces";
import type { SpaceRecord } from "@/spaces/record";
import {
	type BrokerAdmin,
	listParticipants,
	type Participant,
} from "@/storage";
import {
	alertLine,
	focusKey,
	notifyError,
	openNote,
	RELAY_TEXT,
	renderAvatar,
	renderKeepingFocus,
	serial,
} from "@/ui/common";
import { createInvite } from "./invite-action";
import { renderInviteForm } from "./invite-section";
import {
	closeLabel,
	closeShare,
	relayAdmin,
	revokeAccess,
	strandedInvites,
} from "./share-action";
import { presenceNote, type ShareRow, shareRows } from "./share-people";
import { shareSummary } from "./share-summary";

type Pause = Exclude<PauseKind, "off">;

const PAUSE: Record<Pause | "", string> = {
	"": "Off",
	here: "On this device",
	everywhere: "On all my devices",
};

/** One place for a shared folder: its people, invites, pause, stop. */
export class ShareModal extends Modal {
	private participants: Participant[] | null = null;
	private failure: string | null = null;
	private shown = "";
	private redraw = (): void => {};
	private summary: HTMLElement | null = null;
	private unsubscribe: (() => void) | null = null;
	private readonly owner: boolean;
	private readonly admin: BrokerAdmin | null;

	constructor(
		private readonly plugin: PluginHost,
		private readonly record: SpaceRecord,
		private readonly onClosed?: () => void,
	) {
		super(plugin.app);
		this.owner = record.access.kind === "owner";
		this.admin =
			this.owner && isRelayConfigured(plugin.settings)
				? relayAdmin(plugin.settings)
				: null;
	}

	onOpen(): void {
		const { contentEl, plugin, record } = this;
		this.modalEl.addClass("obsync-share-modal");
		this.titleEl.setText(`Sharing "${record.name}"`);
		this.summary = contentEl.createEl("p", {
			cls: "setting-item-description",
			text: shareSummary(plugin.spaces, record),
		});
		const stranded = strandedInvites(plugin, record);
		if (stranded) {
			contentEl.createEl("p", {
				cls: "obsync-share-warning",
				text: `People were invited through ${stranded}, which this vault no longer uses: invite them again, and the new link takes over the folder they have.`,
			});
		}
		this.renderPause();
		heading(contentEl, "People");
		const failure = alertLine(contentEl);
		const list = contentEl.createDiv({ cls: "obsync-share-access" });
		this.redraw = () => this.drawPeople(failure, list);
		this.unsubscribe = plugin.realtime.people.subscribe(this.redraw);
		this.redraw();
		void this.load();
		if (this.owner) this.renderInvite();
		this.renderFooter();
	}

	onClose(): void {
		this.unsubscribe?.();
		this.redraw = () => {};
		this.contentEl.empty();
		this.onClosed?.();
	}

	private async load(): Promise<void> {
		if (!this.admin) return;
		try {
			this.participants = await listParticipants(this.admin, this.record.id);
			this.failure = null;
		} catch (err) {
			this.failure = errorMessage(err);
		}
		this.redraw();
	}

	private renderInvite(): void {
		const { contentEl, plugin, record } = this;
		heading(contentEl, "Invite");
		if (!this.admin) {
			contentEl.createEl("p", {
				cls: "setting-item-description",
				text: `${RELAY_TEXT["no-relay"]} to invite people.`,
			});
			return;
		}
		renderInviteForm(
			contentEl,
			(person, readOnly) => createInvite(plugin, record, person, readOnly),
			() => void this.load(),
		);
	}

	/** The hub announces every space's people: redraw only when this share's rows changed. */
	private drawPeople(failure: HTMLElement, list: HTMLElement): void {
		const rows = shareRows(
			this.plugin.realtime.people.online(this.record.id),
			this.participants,
		);
		const note = this.noteOf(rows);
		const signature = JSON.stringify([this.failure, note, rows]);
		if (signature === this.shown) return;
		this.shown = signature;
		failure.setText(this.failure ?? "");
		renderKeepingFocus(list, () => {
			list.empty();
			if (note)
				list.createEl("p", { cls: "setting-item-description", text: note });
			for (const row of rows) this.renderRow(list, row);
		});
	}

	private noteOf(rows: readonly ShareRow[]): string | null {
		if (this.failure) return null;
		if (this.admin && this.participants === null) return "Loading…";
		const { people, hub } = this.plugin.realtime;
		const { id } = this.record;
		const presence = presenceNote(hub.statusOf(id), people.unreadable(id));
		if (presence) return presence;
		if (rows.length > 0) return null;
		return this.admin
			? "Nobody else can open this folder yet."
			: "Nobody else is here now.";
	}

	private renderRow(list: HTMLElement, row: ShareRow): void {
		const setting = new Setting(list).setName(named(row)).setDesc(row.detail);
		const note = row.person?.note ?? null;
		if (note !== null) {
			setting.addExtraButton((button) => {
				focusKey(button.extraSettingsEl, `note-${row.key}`);
				button
					.setIcon("file-text")
					.setTooltip(`Open ${note}`)
					.onClick(async () => {
						if (await openNote(this.app, note)) this.close();
					});
			});
		}
		const { participant } = row;
		if (!this.admin || !participant) return;
		setting.addButton((button) => {
			focusKey(button.buttonEl, `revoke-${row.key}`);
			button
				.setButtonText("Revoke")
				.setWarning()
				.onClick(() => this.revoke(participant));
		});
	}

	private readonly revoke = serial(async (person: Participant) => {
		try {
			if (await revokeAccess(this.plugin, this.record, person))
				await this.load();
		} catch (err) {
			this.failure = errorMessage(err);
			this.redraw();
		}
	});

	private renderFooter(): void {
		const { plugin, record } = this;
		const label = closeLabel(record);
		new Setting(this.modalEl)
			.setClass("obsync-share-footer")
			.setDesc(
				this.owner
					? "Everyone you invited loses access. The files stay in your vault."
					: "Its changes stop reaching you. The files stay in your vault.",
			)
			.addButton((button) =>
				button
					.setButtonText(label)
					.setWarning()
					.onClick(
						serial(async () => {
							button.setDisabled(true);
							try {
								if (await closeShare(plugin, record)) this.close();
							} catch (err) {
								notifyError(`Could not ${label.toLowerCase()}`, err);
							} finally {
								button.setDisabled(false);
							}
						}),
					),
			);
	}

	/** Shares off here say so in the summary: nothing to choose. */
	private renderPause(): void {
		const { contentEl, plugin, record } = this;
		const { spaces, controller } = plugin;
		const mounted = spaces.partition().some(({ id }) => id === record.id);
		const paused = spaces.pauseOf(record.id);
		if (!mounted || paused === "off") return;
		new Setting(contentEl)
			.setName("Pause")
			.setDesc("Paused, the folder stays as it is and nothing of it syncs.")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(PAUSE)
					.setValue(paused ?? "")
					.onChange(
						serial(async (value) => {
							const pause = value === "" ? null : (value as Pause);
							// A pull or push running now would go on writing into it.
							if (spaces.pauseOf(record.id) === null) controller.cancel();
							dropdown.setDisabled(true);
							try {
								await spaces.setPause(
									record.id,
									pause,
									controller.currentDevice().id,
								);
							} catch (err) {
								notifyError("Could not change pause", err);
							} finally {
								dropdown.setDisabled(false);
							}
							void controller.refresh();
							dropdown.setValue(spaces.pauseOf(record.id) ?? "");
							this.summary?.setText(shareSummary(spaces, record));
						}),
					),
			);
	}
}

function heading(parent: HTMLElement, title: string): void {
	new Setting(parent)
		.setName(title)
		.setHeading()
		.settingEl.addClass("obsync-share-section");
}

function named({ key, name, person }: ShareRow): DocumentFragment {
	const fragment = createFragment();
	renderAvatar(fragment, { key, name, idle: person?.idle ?? false });
	fragment.createSpan({ text: name });
	return fragment;
}
