import type { App } from "obsidian";

import { notifyInfo } from "./notices";

/** False, with a notice, when the note has not reached this device yet. */
export async function openNote(app: App, path: string): Promise<boolean> {
	const file = app.vault.getFileByPath(path);
	if (!file) {
		notifyInfo(`${path} is not on this device yet. Pull to get it.`);
		return false;
	}
	await app.workspace.getLeaf(false).openFile(file);
	return true;
}
