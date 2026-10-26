import type { App, WorkspaceLeaf } from "obsidian";

import { notifyInfo } from "./notices";

/** The tab it opened in; null, with a notice, when the note has not reached this device yet. */
export async function openNote(
	app: App,
	path: string,
): Promise<WorkspaceLeaf | null> {
	const file = app.vault.getFileByPath(path);
	if (!file) {
		notifyInfo(`${path} is not on this device yet. Pull to get it.`);
		return null;
	}
	const leaf = app.workspace.getLeaf(false);
	await leaf.openFile(file);
	return leaf;
}
