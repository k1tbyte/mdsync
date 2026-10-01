import { type App, Modal } from "obsidian";

import { EConflictStrategy } from "@/sync/controller";
import { openConfirmModal } from "@/ui/modals";

export function confirmBatchResolve(
	app: App,
	count: number,
	strategy: EConflictStrategy,
): Promise<boolean> {
	const action =
		strategy === EConflictStrategy.KeepLocal ? "Keep local" : "Accept remote";
	const description =
		strategy === EConflictStrategy.KeepLocal
			? "All local versions will be pushed and overwrite remote."
			: "All remote versions will be downloaded and overwrite local.";
	return openConfirmModal({
		app,
		title: `${action} for ${count} conflict(s)?`,
		body: [description, "This cannot be undone."],
		confirmLabel: action,
	});
}

export function confirmAdoptNewVault(app: App): Promise<boolean> {
	return openConfirmModal({
		app,
		title: "Adopt new remote vault?",
		body: [
			"The remote vault ID has changed, which usually means the remote storage was reset from another device.",
			"Adopting will forget your previous sync baseline. Your local files will be compared against the new remote.",
		],
		confirmLabel: "Adopt",
	});
}

export function showFileList(
	app: App,
	title: string,
	intro: string,
	files: ReadonlyArray<{ path: string; detail?: string }>,
): void {
	const modal = new Modal(app);
	modal.titleEl.setText(`${title} (${files.length})`);
	modal.contentEl.createEl("p", { text: intro });
	const list = modal.contentEl.createEl("ul", { cls: "obsync-ignored-list" });
	for (const { path, detail } of files) {
		const item = list.createEl("li", { cls: "obsync-file-name", text: path });
		if (detail) {
			item.createDiv({ cls: "setting-item-description", text: detail });
		}
	}
	modal.open();
}

/** Revert discards local edits that were never pushed, so it is confirmed. */
export function confirmRevert(
	app: App,
	paths: ReadonlyArray<string>,
	/** Never synced: revert deletes them. */
	added: number,
): Promise<boolean> {
	const first = paths.slice(0, 5);
	return openConfirmModal({
		app,
		title:
			paths.length === 1
				? `Revert "${paths[0]}"?`
				: `Revert ${paths.length} file(s)?`,
		body: [
			"Local changes to these files are replaced with the last synced version. This cannot be undone.",
			...(added > 0
				? [
						`${added} new file(s) among them never synced and will be moved to the trash.`,
					]
				: []),
			...first,
			...(paths.length > first.length
				? [`… and ${paths.length - first.length} more`]
				: []),
		],
		confirmLabel: "Revert",
		cancelLabel: "Keep my changes",
		confirmClass: "mod-warning",
	});
}
