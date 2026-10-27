import type { App } from "obsidian";
import { openConfirmModal } from "@/core/ui";
import { EConflictStrategy } from "../controller";

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

/** Revert discards local edits that were never pushed, so it is confirmed. */
export function confirmRevert(
	app: App,
	paths: ReadonlyArray<string>,
	/** Never synced: revert deletes them. */
	added: number,
): Promise<boolean> {
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
		],
		files: paths.length > 1 ? paths : undefined,
		confirmLabel: "Revert",
		cancelLabel: "Keep my changes",
		confirmClass: "mod-warning",
	});
}
