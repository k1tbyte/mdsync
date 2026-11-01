import type { Menu } from "obsidian";
import { notifyError, notifyInfo, runWithNotice } from "@/core/ui";
import type { SyncHost } from "../host";
import { heldByConflicts } from "./sync-actions";

/** Changes inside `scope`: a file matches itself, a folder everything below it (the vault root "/" covers all). */
export function scopedPaths(
	changes: ReadonlyArray<{ path: string }>,
	scope: string,
	isFolder: boolean,
): string[] {
	const prefix = isFolder ? folderPrefix(scope) : null;
	return changes
		.filter((change) =>
			prefix !== null ? change.path.startsWith(prefix) : change.path === scope,
		)
		.map((change) => change.path);
}

/** The vault root is "/", yet vault paths carry no leading slash. */
function folderPrefix(scope: string): string {
	if (scope === "/") return "";
	return scope.endsWith("/") ? scope : `${scope}/`;
}

/** File-explorer and editor right-click entry: push one file or a folder. */
export function addPushMenuItem(
	menu: Menu,
	plugin: SyncHost,
	path: string,
	isFolder: boolean,
): void {
	const target = isFolder ? "folder" : "file";
	menu.addItem((item) =>
		item
			.setTitle(`MDSync: Push ${target} to remote`)
			.setIcon("upload")
			.onClick(() => void pushScope(plugin, path, isFolder)),
	);
}

export async function pushScope(
	plugin: SyncHost,
	path: string,
	isFolder: boolean,
): Promise<void> {
	const target = isFolder ? "folder" : "file";
	try {
		// A stale diff could push a file another device changed since; compare first, as the push command does.
		await plugin.controller.refresh();
	} catch (err) {
		notifyError(`Could not push ${target}`, err);
		return;
	}
	const snapshot = plugin.controller.getSnapshot();
	const diff = snapshot.result?.diff;
	if (snapshot.error || !diff) {
		notifyError(
			`Could not push ${target}`,
			new Error(snapshot.error ?? "No comparison result."),
		);
		return;
	}
	const paths = scopedPaths(diff.localChanges, path, isFolder);
	// A conflict elsewhere in the same space holds this push too.
	const held = heldByConflicts(plugin.controller, [
		...scopedPaths(diff.conflicts, path, isFolder),
		...paths,
	]);
	if (held) {
		notifyInfo(held);
		await plugin.openSourceControl();
		return;
	}
	if (paths.length === 0) {
		const where =
			isFolder && path === "/"
				? "the vault"
				: isFolder
					? `the folder "${path}"`
					: `"${path}"`;
		notifyInfo(`No local changes to push for ${where}.`);
		return;
	}
	await runWithNotice(
		() => plugin.controller.pushPaths(paths),
		`Pushed ${paths.length} file(s).`,
		`Could not push ${target}`,
	);
}
