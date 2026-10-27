import { ButtonComponent, setIcon } from "obsidian";
import { formatRelativeTime } from "@/core/shared";
import { actionButton, textButton } from "@/core/ui";
import { askSpaceGone } from "@/features/spaces";
import type { Manifest } from "@/features/sync";
import {
	canPullAll,
	canPushAll,
	deviceLabel,
	isVaultMismatch,
	type SyncStatusSnapshot,
	splitSpaceErrors,
} from "@/features/sync";
import type { SourceControlActions } from "./actions/actions";
import { showIgnoredFiles, showSkippedFiles } from "./changes/excluded-files";
import type { SourceControlHost } from "./host";

/**
 * The head of the Changes tab: what is pending, Push and Pull, what keeps files out and what stops a sync.
 * Updated in place while an operation runs, so its buttons keep focus across progress ticks.
 */
export class SummaryCard {
	private readonly el: HTMLElement;
	private readonly iconEl: HTMLElement;
	private readonly titleEl: HTMLElement;
	private readonly subtitleEl: HTMLElement;
	private readonly progressEl: HTMLElement;
	private readonly buttonsEl: HTMLElement;
	private readonly pushButton: HTMLButtonElement;
	private readonly pullButton: HTMLButtonElement;
	private readonly cancelButton: HTMLButtonElement;
	private readonly compareButton: HTMLButtonElement;
	private readonly extrasEl: HTMLElement;
	private readonly footerEl: HTMLElement;
	/** Outside the card: the rest of the vault still syncs. */
	private readonly spaceErrorsEl: HTMLElement;

	/** Trailing slot of the head, for tools that have no room elsewhere. */
	readonly toolsEl: HTMLElement;
	private showTimes = (): void => {};

	/** `dock` takes Push and Pull out of the card, to the bottom of a phone screen. */
	constructor(
		parent: HTMLElement,
		private readonly plugin: SourceControlHost,
		private readonly actions: Pick<
			SourceControlActions,
			"adoptNewVault" | "pushPaths" | "pullPaths"
		>,
		dock?: HTMLElement,
	) {
		this.el = parent.createDiv({ cls: "mdsync-sync-summary" });
		const head = this.el.createDiv({ cls: "mdsync-sync-summary-head" });
		this.iconEl = head.createSpan({ cls: "mdsync-sync-summary-icon" });
		const copy = head.createDiv({ cls: "mdsync-sync-summary-copy" });
		this.titleEl = copy.createDiv({ cls: "mdsync-sync-summary-title" });
		this.subtitleEl = copy.createDiv({ cls: "mdsync-sync-summary-subtitle" });
		this.toolsEl = head.createDiv({ cls: "mdsync-sync-summary-tools" });
		this.progressEl = this.el.createDiv({ cls: "mdsync-sync-progress" });
		this.progressEl.setAttrs({
			role: "progressbar",
			"aria-label": "Sync progress",
			"aria-valuemin": "0",
			"aria-valuemax": "100",
		});
		this.progressEl.createDiv({ cls: "mdsync-sync-progress-fill" });
		this.buttonsEl = (dock ?? this.el).createDiv({
			cls: ["mdsync-sync-summary-buttons", ...(dock ? ["is-docked"] : [])],
		});
		// Read at click time: the diff captured at render is stale once anything syncs.
		const diff = () => plugin.controller.getSnapshot().result?.diff;
		this.pushButton = this.countButton("upload", "Push", true, () => {
			void actions.pushPaths(diff()?.localChanges.map((c) => c.path) ?? []);
		});
		this.pullButton = this.countButton("download", "Pull", false, () => {
			void actions.pullPaths(diff()?.remoteChanges.map((c) => c.path) ?? []);
		});
		this.cancelButton = actionButton(this.buttonsEl, "warning")
			.setButtonText("Cancel")
			.onClick(() => plugin.controller.cancel()).buttonEl;
		this.cancelButton.setAttr("aria-label", "Stop the running sync");
		this.compareButton = textButton(this.el, "Compare again").onClick(
			() => void plugin.controller.refreshFromDisk(),
		).buttonEl;
		this.extrasEl = this.el.createDiv({ cls: "mdsync-sync-summary-extras" });
		this.footerEl = this.el.createDiv({ cls: "mdsync-sync-summary-footer" });
		this.spaceErrorsEl = parent.createDiv({ cls: "mdsync-space-errors" });
	}

	/** "Compared ..." and "Last push ..." age while nothing broadcasts; the rest stays, focus included. */
	refreshTimes(): void {
		this.showTimes();
	}

	update(snapshot: SyncStatusSnapshot): void {
		const { pendingLocal, pendingRemote, conflicts, busy, error } = snapshot;
		const pending = pendingLocal + pendingRemote + conflicts;
		const offline = snapshot.offline && !busy;
		const { broken, unreachable } = splitSpaceErrors(snapshot.spaceErrors);
		// A shared folder that failed to compare may hold changes nobody sees; offline explains them all.
		const failed = !offline && (Boolean(error) || broken.length > 0);
		// Folders that only wait for their connection: nothing broke, but they are not compared either.
		const waiting = !offline && !failed && unreachable.length > 0;
		const clean =
			!busy &&
			!offline &&
			!failed &&
			!waiting &&
			snapshot.result !== null &&
			pending === 0;
		// Nothing but the connection to say, so the card is an empty state with a retry.
		const parked = offline || (waiting && pending === 0);
		const mismatch = isVaultMismatch(snapshot.error);
		this.el.toggleClass("is-error", Boolean(error) && !snapshot.offline);
		this.el.toggleClass("is-warning", failed && !error);
		this.el.toggleClass("is-offline", parked);
		this.el.toggleClass("is-busy", busy);
		this.el.toggleClass("is-clean", clean);
		setIcon(
			this.iconEl,
			busy
				? "refresh-cw"
				: parked
					? "cloud-off"
					: failed
						? "triangle-alert"
						: clean
							? "circle-check"
							: "refresh-cw",
		);
		this.titleEl.setText(
			mismatch
				? "This storage holds another vault"
				: offline
					? "You're offline"
					: error
						? "Sync stopped"
						: busy
							? (snapshot.progressText ?? "Syncing…")
							: !snapshot.result
								? "Not compared yet"
								: clean
									? "Everything is in sync"
									: pending === 0
										? waiting
											? "Some shared folders are offline"
											: "Some shared folders did not compare"
										: `${pending.toLocaleString()} ${pending === 1 ? "change" : "changes"} to sync`,
		);
		const remote = clean ? snapshot.result?.remote : null;
		this.showTimes = () => {
			const compared = snapshot.lastCompareAt
				? `Compared ${formatRelativeTime(snapshot.lastCompareAt)}`
				: "Compare to see what changed";
			this.subtitleEl.setText(
				mismatch
					? "The remote vault id does not match this one. Nothing was pushed or pulled."
					: offline
						? snapshot.lastCompareAt
							? `${compared}. MDSync syncs when the connection is back.`
							: "MDSync compares when the connection is back."
						: (error ??
							snapshot.staleReason ??
							(clean
								? `This vault matches the remote. ${compared}.`
								: parked
									? `${compared}. They compare again when the connection is back.`
									: compared)),
			);
			this.footerEl.setText(remote ? this.lastPush(remote) : "");
		};
		this.showTimes();
		const ratio = busy ? snapshot.progressRatio : null;
		this.progressEl.toggleClass("mdsync-hidden", ratio === null);
		if (ratio !== null) {
			// A variable, not a width: the fill scales without a layout per tick.
			this.progressEl.style.setProperty("--mdsync-progress", String(ratio));
			this.progressEl.setAttr("aria-valuenow", String(Math.round(ratio * 100)));
		}
		this.compareButton.toggleClass("mdsync-hidden", !clean && !parked);
		this.compareButton
			.querySelector(".mdsync-button-text")
			?.setText(parked ? "Try again" : "Compare again");
		this.footerEl.toggleClass("mdsync-hidden", !remote);

		const cancellable = snapshot.cancellable;
		this.setCount(this.pushButton, pendingLocal, !canPushAll(snapshot));
		this.setCount(this.pullButton, pendingRemote, !canPullAll(snapshot));
		this.pushButton.toggleClass("mdsync-hidden", cancellable);
		this.pullButton.toggleClass("mdsync-hidden", cancellable);
		this.cancelButton.toggleClass("mdsync-hidden", !cancellable);
		this.buttonsEl.toggleClass("is-cancellable", cancellable);
		this.buttonsEl.toggleClass(
			"mdsync-hidden",
			!cancellable && pendingLocal + pendingRemote === 0,
		);
		this.fillExtras(snapshot);
	}

	private countButton(
		icon: string,
		text: string,
		cta: boolean,
		run: () => void,
	): HTMLButtonElement {
		const component = new ButtonComponent(this.buttonsEl);
		if (cta) component.setCta();
		const button = component.buttonEl;
		setIcon(
			button.createSpan({ cls: "mdsync-sync-summary-button-icon" }),
			icon,
		);
		button.createSpan({ cls: "mdsync-button-text", text });
		button.createSpan({ cls: "mdsync-sync-summary-count" });
		button.dataset.mdsyncVerb = text;
		button.addEventListener("click", run);
		return button;
	}

	private setCount(
		button: HTMLButtonElement,
		count: number,
		disabled: boolean,
	): void {
		button.disabled = disabled;
		button
			.querySelector(".mdsync-sync-summary-count")
			?.setText(count.toLocaleString());
		button.setAttr(
			"aria-label",
			`${button.dataset.mdsyncVerb} all ${count} changes`,
		);
	}

	private fillExtras(snapshot: SyncStatusSnapshot): void {
		const plugin = this.plugin;
		const extras = this.extrasEl;
		extras.empty();
		if (isVaultMismatch(snapshot.error)) {
			actionButton(extras, "warning")
				.setButtonText("Resolve vault mismatch")
				.onClick(() => void this.actions.adoptNewVault())
				.buttonEl.addClass("mdsync-adopt-new-vault-btn");
		}
		const spaceErrors = this.spaceErrorsEl;
		spaceErrors.empty();
		// Offline, the vault's own state says it all.
		for (const error of snapshot.offline ? [] : snapshot.spaceErrors) {
			const { root, gone, offline } = error;
			const { title, desc } = spaceErrorText(error);
			const card = spaceErrors.createDiv({
				cls: ["mdsync-space-error", ...(offline ? ["is-offline"] : [])],
			});
			card.createDiv({ cls: "mdsync-space-error-title", text: title });
			card.createDiv({ cls: "mdsync-space-error-desc", text: desc });
			if (!gone) continue;
			textButton(card, "Resolve…").onClick(
				() => void askSpaceGone(plugin, plugin.controller.spaceFor(root)),
			);
		}

		const blocked = blockedHint(snapshot);
		if (blocked) note(extras, blocked);

		const chips = extras.createDiv({ cls: "mdsync-sync-summary-chips" });
		const ignored = snapshot.result?.snapshot.ignoredPaths ?? [];
		chip(chips, "eye-off", ignored.length, "ignored", () =>
			showIgnoredFiles(plugin, ignored),
		);
		const skipped = snapshot.result?.snapshot.skipped ?? [];
		chip(chips, "cloud-off", skipped.length, "not synced", () =>
			showSkippedFiles(plugin, skipped),
		);
		if (chips.childElementCount === 0) chips.remove();

		const spaces = plugin.spaces.partition();
		const paused = spaces
			.filter((space) => space.paused)
			.map((space) => `"${space.root}"`);
		// Turned off on purpose: they would only nag.
		if (paused.length > 0 && plugin.settings.useSharedFolders) {
			note(
				extras,
				`Paused on this device, not compared: ${paused.join(", ")}.`,
			);
		}
		const full = spaces
			.filter(({ id }) => plugin.realtime.hub.statusOf(id) === "full")
			.map((space) => `"${space.root}"`);
		if (full.length > 0) {
			note(
				extras,
				`No room on the relay, they sync on the schedule: ${full.join(", ")}. Pause a shared folder you do not need here to make room.`,
			);
		}
		extras.toggleClass("mdsync-hidden", extras.childElementCount === 0);
	}

	private lastPush(remote: Manifest): string {
		const from =
			remote.deviceId === this.plugin.controller.currentDevice().id
				? "this device"
				: deviceLabel(remote.deviceId, remote.deviceName);
		return `Last push ${formatRelativeTime(remote.createdAt)} from ${from}`;
	}
}

function spaceErrorText({
	root,
	message,
	gone,
	offline,
}: SyncStatusSnapshot["spaceErrors"][number]): {
	title: string;
	desc: string;
} {
	if (gone) {
		return {
			title: `"${root}" is missing`,
			desc: "The shared folder was moved or deleted here. The rest of the vault keeps syncing.",
		};
	}
	if (offline) {
		return {
			title: `"${root}" is offline`,
			desc: `${message} It compares again when the connection is back.`,
		};
	}
	return { title: `"${root}" did not compare`, desc: message };
}

function note(parent: HTMLElement, text: string): void {
	parent.createDiv({ cls: "mdsync-sync-summary-note", text });
}

function chip(
	parent: HTMLElement,
	icon: string,
	count: number,
	what: string,
	open: () => void,
): void {
	if (count === 0) return;
	const badge = parent.createEl("button", {
		cls: `mdsync-sync-summary-chip is-${icon}`,
	});
	setIcon(badge, icon);
	badge.createSpan({ text: `${count.toLocaleString()} ${what}` });
	badge.addEventListener("click", open);
}

/** Why Push or Pull of everything is off while there is something to sync; selected files still go. */
function blockedHint(snapshot: SyncStatusSnapshot): string | null {
	const diff = snapshot.result?.diff;
	if (snapshot.busy || !diff) return null;
	const { conflicts, localChanges, remoteChanges } = diff;
	if (conflicts.length > 0 && localChanges.length + remoteChanges.length > 0) {
		return "Resolve the conflicts to push or pull everything.";
	}
	if (remoteChanges.length > 0 && localChanges.length > 0) {
		return "Pull first to push everything.";
	}
	return null;
}
