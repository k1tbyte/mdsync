import { ButtonComponent, setIcon } from "obsidian";
import type { PluginHost } from "@/plugin/host";
import { formatRelativeTime } from "@/shared";
import type { SyncStatusSnapshot } from "@/sync/controller";
import { skippedText } from "@/ui/common";
import { askSpaceGone } from "@/ui/shares/space-gone";
import { actionButton } from "./action-button";
import type { SourceControlActions } from "./actions";
import { showFileList } from "./modals";

/**
 * The head of the Changes tab: what is pending, Push and Pull, what keeps files out and what stops a sync.
 * Updated in place while an operation runs, so its buttons keep focus across progress ticks.
 */
export class SummaryCard {
	private readonly el: HTMLElement;
	private readonly iconEl: HTMLElement;
	private readonly titleEl: HTMLElement;
	private readonly subtitleEl: HTMLElement;
	private readonly buttonsEl: HTMLElement;
	private readonly pushButton: HTMLButtonElement;
	private readonly pullButton: HTMLButtonElement;
	private readonly cancelButton: HTMLButtonElement;
	private readonly extrasEl: HTMLElement;

	/** Trailing slot of the head, for tools that have no room elsewhere. */
	readonly toolsEl: HTMLElement;

	/** `dock` takes Push and Pull out of the card, to the bottom of a phone screen. */
	constructor(
		parent: HTMLElement,
		private readonly plugin: PluginHost,
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
		this.extrasEl = this.el.createDiv({ cls: "mdsync-sync-summary-extras" });
	}

	update(snapshot: SyncStatusSnapshot): void {
		const { pendingLocal, pendingRemote, conflicts, busy, error } = snapshot;
		const pending = pendingLocal + pendingRemote + conflicts;
		// A shared folder that failed to compare may hold changes nobody sees.
		const failed = Boolean(error) || snapshot.spaceErrors.length > 0;
		const clean = !busy && !failed && snapshot.result !== null && pending === 0;
		this.el.toggleClass("is-error", failed);
		this.el.toggleClass("is-busy", busy);
		this.el.toggleClass("is-clean", clean);
		setIcon(
			this.iconEl,
			busy
				? "refresh-cw"
				: failed
					? "triangle-alert"
					: clean
						? "circle-check"
						: "refresh-cw",
		);
		this.titleEl.setText(
			error
				? "Sync stopped"
				: busy
					? (snapshot.progressText ?? "Syncing…")
					: !snapshot.result
						? "Not compared yet"
						: clean
							? "Everything is in sync"
							: pending === 0
								? "Some shared folders did not compare"
								: `${pending.toLocaleString()} ${pending === 1 ? "change" : "changes"} to sync`,
		);
		this.subtitleEl.setText(
			error ??
				snapshot.staleReason ??
				(snapshot.lastCompareAt
					? `Compared ${formatRelativeTime(snapshot.lastCompareAt)}`
					: "Compare to see what changed"),
		);

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
		if (snapshot.error?.includes("Remote vault id does not match local")) {
			actionButton(extras, "warning")
				.setButtonText("Resolve vault mismatch")
				.onClick(() => void this.actions.adoptNewVault())
				.buttonEl.addClass("mdsync-adopt-new-vault-btn");
		}
		for (const { root, message, gone } of snapshot.spaceErrors) {
			const row = extras.createDiv({
				cls: "mdsync-sync-summary-note is-error",
				text: `Error in "${root}": ${message}`,
			});
			if (!gone) continue;
			actionButton(row, "warning")
				.setButtonText("Resolve…")
				.onClick(
					() => void askSpaceGone(plugin, plugin.controller.spaceFor(root)),
				);
		}
		if (snapshot.spaceErrors.length > 0) {
			note(
				extras,
				"Restore the folder, or stop sharing or leave it in MDSync settings (Sync tab).",
			);
		}

		const blocked = blockedHint(snapshot);
		if (blocked) note(extras, blocked);

		const chips = extras.createDiv({ cls: "mdsync-sync-summary-chips" });
		const ignored = snapshot.result?.snapshot.ignoredPaths ?? [];
		chip(chips, "eye-off", ignored.length, "ignored", () =>
			showFileList(
				plugin.app,
				"Ignored files",
				"These files are excluded by shared syncignore.md rules or device-local ignore settings.",
				ignored.map((path) => ({ path })),
			),
		);
		const skipped = snapshot.result?.snapshot.skipped ?? [];
		const max = plugin.settings.maxFileBytes;
		chip(chips, "cloud-off", skipped.length, "not synced", () =>
			showFileList(
				plugin.app,
				"Not synced",
				"These files stay on this device only until what is named below changes.",
				skipped.map((file) => ({
					path: file.path,
					detail: skippedText(file, max),
				})),
			),
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

function canPushAll(snapshot: SyncStatusSnapshot): boolean {
	const diff = snapshot.result?.diff;
	return (
		!snapshot.busy &&
		!!diff &&
		diff.conflicts.length === 0 &&
		diff.remoteChanges.length === 0 &&
		diff.localChanges.length > 0
	);
}

function canPullAll(snapshot: SyncStatusSnapshot): boolean {
	const diff = snapshot.result?.diff;
	return (
		!snapshot.busy &&
		!!diff &&
		diff.conflicts.length === 0 &&
		diff.remoteChanges.length > 0
	);
}
