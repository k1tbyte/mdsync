import { ButtonComponent, Modal } from "obsidian";
import type { PluginHost } from "@/app/host";
import { isLinkState, RELAY_TEXT, relaySummary } from "@/core/hub";
import { isRelayConfigured } from "@/core/settings";
import { errorMessage } from "@/core/shared";
import {
	alertLine,
	modalCard,
	modalFooter,
	modalHint,
	modalSection,
	modalWarning,
	notifyError,
	openNote,
	renderKeepingFocus,
	serial,
} from "@/core/ui";
import type { Person } from "@/features/presence";
import { isUnder } from "@/features/sync";
import {
	type BrokerAdmin,
	listParticipants,
	type Participant,
	relayAdmin,
} from "../../broker/share-broker";
import { type SpaceRecord, shareIdentity } from "../../record";
import { createInvite } from "../invites/invite-action";
import { renderInviteForm } from "../invites/invite-section";
import {
	closeLabel,
	closeShare,
	revokeAccess,
	strandedInvites,
} from "../share-action";
import { type Pause, renderPauseControl } from "./pause-control";
import { renderPeople } from "./people-list";
import { renderShareHead } from "./share-head";
import { presenceNote, selfRow, shareRows } from "./share-people";

/** One place for a shared folder: its people, invites, pause, stop. */
export class ShareModal extends Modal {
	private participants: Participant[] | null = null;
	private failure: string | null = null;
	private shown = "";
	private redraw = (): void => {};
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
		this.modalEl.addClass("mdsync-share-modal");
		const relay = renderShareHead(this, record);
		this.renderWarnings();
		const count = modalSection(contentEl, "People");
		const failure = alertLine(contentEl);
		const note = modalHint(contentEl);
		const list = modalCard(contentEl);
		list.addClass("mdsync-share-people");
		this.redraw = () => {
			const { hub, people } = plugin.realtime;
			const status = hub.statusOf(record.id);
			const unreadable = people.unreadable(record.id);
			relay(
				isLinkState(status)
					? {
							live: status === "connected" && !unreadable,
							text: relaySummary([status], unreadable),
						}
					: null,
			);
			this.drawPeople(count, failure, note, list);
		};
		this.unsubscribe = plugin.realtime.people.subscribe(this.redraw);
		this.redraw();
		void this.load();
		if (this.owner) this.renderInvite();
		this.renderPause();
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

	/** What keeps it from syncing here, where the pause control cannot say it. */
	private renderWarnings(): void {
		const { contentEl, plugin, record } = this;
		const { spaces } = plugin;
		const lines = [];
		if (!spaces.partition().some(({ id }) => id === record.id)) {
			lines.push(
				`Not syncing: another shared folder already holds "${record.root}".`,
			);
		} else if (spaces.pauseOf(record.id) === "off") {
			lines.push("Shared folders are off on this device.");
		}
		const stranded = strandedInvites(plugin, record);
		if (stranded) {
			lines.push(
				`People were invited through ${stranded}, which this vault no longer uses: invite them again, and the new link takes over the folder they have.`,
			);
		}
		for (const text of lines) modalWarning(contentEl, text);
	}

	private renderInvite(): void {
		const { contentEl, plugin, record } = this;
		modalSection(contentEl, "Invite someone");
		if (!this.admin) {
			modalHint(contentEl, `${RELAY_TEXT["no-relay"]} to invite people.`);
			return;
		}
		renderInviteForm(
			contentEl,
			(person, readOnly) => createInvite(plugin, record, person, readOnly),
			() => void this.load(),
		);
	}

	/** The hub announces every space's people: redraw only when this share's rows changed. */
	private drawPeople(
		count: HTMLElement,
		failure: HTMLElement,
		noteEl: HTMLElement,
		list: HTMLElement,
	): void {
		const { plugin, record } = this;
		const identity = shareIdentity(record).person;
		const rows = shareRows(
			plugin.realtime.people.online(record.id),
			this.participants,
			identity,
		);
		const open = plugin.app.workspace.getActiveFile()?.path ?? null;
		const self = selfRow(
			record,
			open !== null && isUnder(open, record.root) ? open : null,
		);
		const note = this.noteOf(rows.length);
		const signature = JSON.stringify([this.failure, note, self, rows]);
		if (signature === this.shown) return;
		this.shown = signature;
		count.setText(`People · ${rows.length + 1}`);
		failure.setText(this.failure ?? "");
		noteEl.setText(note ?? "");
		renderKeepingFocus(list, () => {
			list.empty();
			renderPeople(list, self, rows, {
				follow: (person) => void this.follow(person),
				open: (path) => void this.openNote(path),
				revoke: this.admin ? (person) => void this.revoke(person) : undefined,
			});
		});
	}

	private noteOf(others: number): string | null {
		if (this.failure) return null;
		if (this.admin && this.participants === null) return "Loading…";
		const { people, hub } = this.plugin.realtime;
		const { id } = this.record;
		const presence = presenceNote(hub.statusOf(id), people.unreadable(id));
		if (presence) return presence;
		if (others > 0) return null;
		return this.admin
			? "Nobody else can open this folder yet."
			: "Nobody else is here now.";
	}

	private async follow(person: Person): Promise<void> {
		if (await this.plugin.follows.follow(this.record.id, person)) this.close();
	}

	private async openNote(path: string): Promise<void> {
		if (await openNote(this.app, path)) this.close();
	}

	private readonly revoke = serial(async (person: Participant) => {
		try {
			if (await revokeAccess(this.plugin, this.record, person)) {
				await this.load();
			}
		} catch (err) {
			this.failure = errorMessage(err);
			this.redraw();
		}
	});

	/** Shares off here say so above: nothing to choose. */
	private renderPause(): void {
		const { contentEl, plugin, record } = this;
		const { spaces, controller } = plugin;
		const mounted = spaces.partition().some(({ id }) => id === record.id);
		if (!mounted || spaces.pauseOf(record.id) === "off") return;
		renderPauseControl(
			contentEl,
			modalSection(contentEl, "Pause syncing"),
			`mdsync-pause-${record.id}`,
			() => spaces.pauseOf(record.id) as Pause | null,
			async (pause) => {
				// A pull or push running now would go on writing into it.
				if (spaces.pauseOf(record.id) === null) controller.cancel();
				try {
					await spaces.setPause(
						record.id,
						pause,
						controller.currentDevice().id,
					);
				} catch (err) {
					notifyError("Could not change pause", err);
				}
				void controller.refresh();
			},
		);
		modalHint(
			contentEl,
			"Paused, the folder stays as it is and nothing of it syncs.",
		);
	}

	private renderFooter(): void {
		const { plugin, record } = this;
		const label = closeLabel(record);
		const footer = modalFooter(this);
		const close = new ButtonComponent(footer)
			.setButtonText(`${label}…`)
			.setDestructive();
		close.onClick(
			serial(async () => {
				close.setDisabled(true);
				try {
					if (await closeShare(plugin, record)) this.close();
				} catch (err) {
					notifyError(`Could not ${label.toLowerCase()}`, err);
				} finally {
					close.setDisabled(false);
				}
			}),
		);
		new ButtonComponent(footer)
			.setButtonText("Done")
			.onClick(() => this.close());
	}
}
