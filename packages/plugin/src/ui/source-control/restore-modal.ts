import { ButtonComponent, Modal } from "obsidian";
import type { PluginHost } from "@/plugin/host";
import { errorMessage, formatBytes } from "@/shared";
import type { FileDiffModel, HistoryVersionRef } from "@/sync/projection";
import { alertLine } from "@/ui/common";
import { renderHunkPreview } from "@/ui/diff";
import { openPromiseModal } from "@/ui/modals";
import { actionButton } from "./action-button";

export interface RestoreConfirmOptions {
	plugin: PluginHost;
	/** File the version belongs to; also the diff's other side. */
	path: string;
	version: HistoryVersionRef;
	/** Where the content lands. Differs from `path` for a restore-to. */
	target: string;
}

export interface BulkRestoreEntry {
	path: string;
	/** "deleted 3 days ago" / "last seen …", pre-built by the trash rows. */
	label: string;
	size: number;
}

/**
 * Previews what a restore would change; the diff loads after the modal opens so the user never waits on a
 * blank screen.
 */
export function confirmRestore(
	options: RestoreConfirmOptions,
): Promise<boolean> {
	return openPromiseModal<boolean>((answer) => {
		const modal = new Modal(options.plugin.app);
		const finish = (confirmed: boolean): void => {
			answer(confirmed);
			modal.close();
		};
		const exists =
			options.plugin.app.vault.getAbstractFileByPath(options.target) !== null;
		modal.titleEl.setText(
			exists
				? `Restore "${options.target}"?`
				: `Bring back "${options.target}"?`,
		);
		modal.contentEl.createEl("p", {
			cls: "obsync-restore-summary",
			text: exists
				? `Replaces what is in the vault with the version from ${options.version.label} (${formatBytes(options.version.size ?? 0)}). Nothing is pushed until you say so.`
				: `Writes the version from ${options.version.label} (${formatBytes(options.version.size ?? 0)}) back into the vault. Nothing is pushed until you say so.`,
		});
		const body = modal.contentEl.createDiv({ cls: "obsync-restore-diff" });
		body.createDiv({ cls: "obsync-status-line", text: "Loading changes…" });

		const buttons = modal.contentEl.createDiv({ cls: "obsync-modal-buttons" });
		const cancel = new ButtonComponent(buttons)
			.setButtonText("Cancel")
			.onClick(() => finish(false));
		// Nothing to confirm until the preview is on screen.
		const confirm = actionButton(buttons, "cta")
			.setButtonText("Restore")
			.setDisabled(true)
			.onClick(() => finish(true));
		// Cancel, not Restore: a stray Enter must not write to the vault.
		window.setTimeout(() => cancel.buttonEl.focus(), 0);

		void loadPreview(options)
			.then((model) => {
				renderPreview(body, model);
				confirm.setDisabled(model === null);
			})
			.catch((err: unknown) => {
				body.empty();
				body.createDiv({
					cls: "obsync-history-error",
					text: `Could not preview the change, so the restore is blocked: ${errorMessage(err)}`,
				});
			});
		return modal;
	}, false);
}

async function loadPreview(
	options: RestoreConfirmOptions,
): Promise<FileDiffModel | null> {
	return options.plugin.controller.history.getHistoryDiff({
		// Diff against the target, not the original path: that is what gets replaced.
		path: options.target,
		// Current on the left, so "+" is what the restore brings back.
		left: { current: true },
		right: { version: options.version },
	});
}

/** Names every file a bulk restore would bring back; no diff preview, as the trash rows offer Preview per file. */
export function confirmBulkRestore(
	plugin: PluginHost,
	entries: readonly BulkRestoreEntry[],
): Promise<boolean> {
	return openPromiseModal<boolean>((answer) => {
		const modal = new Modal(plugin.app);
		const finish = (confirmed: boolean): void => {
			answer(confirmed);
			modal.close();
		};
		modal.titleEl.setText(
			entries.length === 1
				? `Bring back "${entries[0]?.path}"?`
				: `Bring back ${entries.length} deleted files?`,
		);
		modal.contentEl.createEl("p", {
			cls: "obsync-restore-summary",
			text: "Writes each version below back into the vault. Nothing is pushed until you say so. Use a row's Preview to inspect a file first.",
		});
		// A file recreated since its deletion is overwritten, as a single restore warns.
		const present = entries.filter(
			(entry) => plugin.app.vault.getAbstractFileByPath(entry.path) !== null,
		);
		if (present.length > 0) {
			alertLine(modal.contentEl).setText(
				`${present.length} of them are in the vault again: their current content is replaced.`,
			);
		}
		const list = modal.contentEl.createDiv({ cls: "obsync-bulk-restore-list" });
		for (const entry of entries) {
			const replaces = present.includes(entry)
				? ", replaces the current file"
				: "";
			list.createDiv({
				text: `${entry.path} - ${entry.label} (${formatBytes(entry.size)})${replaces}`,
			});
		}
		const buttons = modal.contentEl.createDiv({ cls: "obsync-modal-buttons" });
		const cancel = new ButtonComponent(buttons)
			.setButtonText("Cancel")
			.onClick(() => finish(false));
		actionButton(buttons, "cta")
			.setButtonText("Restore")
			.onClick(() => finish(true));
		// Cancel, not Restore: a stray Enter must not write to the vault.
		window.setTimeout(() => cancel.buttonEl.focus(), 0);
		return modal;
	}, false);
}

function renderPreview(body: HTMLElement, model: FileDiffModel | null): void {
	body.empty();
	if (!model) {
		body.createDiv({
			cls: "obsync-status-line",
			text: "This version is no longer available.",
		});
		return;
	}
	if (model.isBinary) {
		body.createDiv({
			cls: "obsync-status-line",
			text: `Binary file. ${formatBytes(model.rightSize)} replaces ${formatBytes(model.leftSize)}.`,
		});
		return;
	}
	const hunks = model.hunks.hunks;
	if (hunks.length === 0) {
		body.createDiv({
			cls: "obsync-status-line",
			// leftPresent is the working copy: absent means this creates the file.
			text: model.leftPresent
				? "This version is identical to the file on disk."
				: "This file is not in the vault; restoring creates it.",
		});
		return;
	}
	for (const hunk of hunks) {
		renderHunkPreview(body, hunk);
	}
}
