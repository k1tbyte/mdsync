import type { LinkStatus } from "@mdsync/protocol";
import {
	ButtonComponent,
	type EventRef,
	Modal,
	Setting,
	type TFile,
} from "obsidian";
import type { PluginHost } from "@/app/host";
import {
	copyText,
	modalCard,
	modalFooter,
	modalHint,
	notifyError,
	openConfirmModal,
	renderModalHead,
	serial,
} from "@/core/ui";
import { runWithConcurrency } from "@/core/utils";
import { linkStatusText } from "../describe";
import { linkError } from "../errors";
import { linkStatusOf, revokeLinkRecord } from "../publish";
import {
	isExpired,
	isStale,
	type LinkRecord,
	noteName,
	onRelay,
} from "../record";

import { updateSharedLinks } from "./link-actions";

const STATUS_CONCURRENCY = 4;

/** Null: the relay no longer has it. */
type Known = LinkStatus | null | Error;

/** The links this device published: where each stands, and copy, update or stop. */
export class ManageLinksModal extends Modal {
	private readonly known = new Map<string, Known>();
	private closed = false;
	private frame: number | null = null;
	/** Follows a rename while open, where the path would not. */
	private note: TFile | null = null;
	private unsubscribe: (() => void) | null = null;
	private modifyRef: EventRef | null = null;

	constructor(
		private readonly plugin: PluginHost,
		/** Only this note's links; all of them without it. */
		private readonly path?: string,
	) {
		super(plugin.app);
	}

	onOpen(): void {
		this.modalEl.addClass("mdsync-link-modal");
		this.note = this.path ? this.app.vault.getFileByPath(this.path) : null;
		renderModalHead(this, {
			icon: "link",
			title: this.path ? "Links of this note" : "Share links",
			sub: this.note?.basename,
		});
		new ButtonComponent(modalFooter(this))
			.setButtonText("Done")
			.onClick(() => this.close());
		// Rows hold their records: a rename, an update or an edit elsewhere must redraw them.
		this.unsubscribe = this.plugin.sharedLinks.subscribe(() => this.draw());
		this.modifyRef = this.app.vault.on("modify", (file) => {
			if (this.records().some(({ path }) => path === file.path)) this.draw();
		});
		this.draw();
		void this.load();
	}

	onClose(): void {
		this.closed = true;
		if (this.frame !== null) window.cancelAnimationFrame(this.frame);
		this.unsubscribe?.();
		if (this.modifyRef) this.app.vault.offref(this.modifyRef);
		this.contentEl.empty();
	}

	private records(): LinkRecord[] {
		const path = this.note?.path ?? this.path;
		const records = path
			? this.plugin.sharedLinks.of(path)
			: this.plugin.sharedLinks.all();
		return [...records].sort((a, b) => b.createdAt - a.createdAt);
	}

	private reachable(record: LinkRecord): boolean {
		return onRelay(record, this.plugin.settings);
	}

	/** Asks the relay where these stand; one update need not ask about the rest. */
	private async load(records = this.records()): Promise<void> {
		await runWithConcurrency(
			records.filter((record) => this.reachable(record) && !isExpired(record)),
			STATUS_CONCURRENCY,
			async (record) => {
				try {
					this.known.set(record.id, await linkStatusOf(this.plugin, record));
				} catch (err) {
					this.known.set(record.id, linkError(err));
				}
				this.drawSoon();
			},
		);
	}

	/** Answers arrive in bursts: one redraw per frame, not per answer. */
	private drawSoon(): void {
		if (this.closed || this.frame !== null) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = null;
			this.draw();
		});
	}

	private draw(): void {
		const list = this.contentEl;
		list.empty();
		const records = this.records();
		if (records.length === 0) {
			modalHint(
				list,
				"No links yet. Open a note's menu and select MDSync: Share link.",
			);
			return;
		}
		const card = modalCard(list);
		for (const record of records) this.drawRow(card, record);
	}

	private drawRow(list: HTMLElement, record: LinkRecord): void {
		const reachable = this.reachable(record);
		// Expiry redraws without asking the relay again.
		const known = isExpired(record) ? null : this.known.get(record.id);
		const ended = known === null || !reachable;
		const file = record.detached
			? null
			: this.app.vault.getFileByPath(record.path);
		const stale = file && isStale(record, file.stat.mtime);
		const deleted = record.detached ? "The note was deleted. " : "";
		const setting = new Setting(list)
			.setName(noteName(record))
			.setDesc(
				`${deleted}${stale ? "Changed since it was shared. " : ""}${describe(record, reachable, known)}`,
			);
		if (record.path.includes("/")) {
			setting.descEl.createDiv({ text: record.path });
		}
		if (!ended) {
			setting.addExtraButton((button) =>
				button
					.setIcon("copy")
					.setTooltip("Copy link")
					.onClick(() => void copyText("Link", record.url)),
			);
		}
		if (!ended && !record.detached) {
			setting.addButton((button) =>
				button.setButtonText("Update").onClick(
					this.guarded(button, async () => {
						await updateSharedLinks(this.plugin, [record]);
						await this.load([record]);
					}),
				),
			);
		}
		setting.addExtraButton((button) =>
			button
				.setIcon("trash-2")
				.setTooltip(ended ? "Remove from the list" : "Stop sharing")
				.onClick(this.guarded(button, () => this.stop(record, ended))),
		);
	}

	private guarded(
		button: { setDisabled(disabled: boolean): unknown },
		action: () => Promise<void>,
	): () => Promise<void> {
		return serial(async () => {
			button.setDisabled(true);
			try {
				await action();
			} catch (err) {
				notifyError("Could not change the link", linkError(err));
			} finally {
				button.setDisabled(false);
			}
		});
	}

	/** An ended link, or one of another relay, only leaves the list: there is nothing here to stop. */
	private async stop(record: LinkRecord, listOnly: boolean): Promise<void> {
		if (listOnly) {
			await this.plugin.sharedLinks.remove(record.id);
		} else {
			const confirmed = await openConfirmModal({
				app: this.plugin.app,
				title: "Stop sharing this link?",
				body: [
					`The link to "${noteName(record)}" stops working at once. Anyone who already opened it keeps what they saw.`,
				],
				confirmLabel: "Stop sharing",
				confirmClass: "mod-warning",
			});
			if (!confirmed) return;
			await revokeLinkRecord(this.plugin, record);
		}
		if (!this.closed) this.draw();
	}
}

function describe(
	record: LinkRecord,
	reachable: boolean,
	known: Known | undefined,
): string {
	if (!reachable) {
		if (!URL.canParse(record.url)) {
			return "This link's address is damaged: remove it from the list.";
		}
		return `Made through ${new URL(record.url).origin}, which is not this vault's relay: set that relay again to manage it.`;
	}
	if (known === undefined) return "Checking…";
	if (known instanceof Error) {
		return `Could not reach the relay: ${known.message}`;
	}
	return linkStatusText(record, known);
}
