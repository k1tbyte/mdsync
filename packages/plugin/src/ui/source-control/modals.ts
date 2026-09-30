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

export function showIgnoredFiles(app: App, paths: ReadonlyArray<string>): void {
	const modal = new Modal(app);
	modal.titleEl.setText(`Ignored files (${paths.length})`);
	modal.contentEl.createEl("p", {
		text: "These files are excluded by shared syncignore.md rules or device-local ignore settings.",
	});
	const list = modal.contentEl.createEl("ul", { cls: "obsync-ignored-list" });
	for (const p of paths) {
		list.createEl("li", { cls: "obsync-file-name", text: p });
	}
	modal.open();
}

/** Revert discards local edits that were never pushed, so it is confirmed. */
export function confirmRevert(
	app: App,
	paths: ReadonlyArray<string>,
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
