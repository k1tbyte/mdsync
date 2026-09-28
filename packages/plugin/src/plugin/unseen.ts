import type { Plugin } from "obsidian";

import { Unseen } from "@/presence/unseen";
import { type Space, VAULT_SPACE } from "@/sync/space";

const STORAGE_KEY = "obsync-unseen";

/** Unseen files kept per vault on this device, cleared as each is opened, moved as it is. */
export function registerUnseen(plugin: Plugin): Unseen {
	const { vault, workspace } = plugin.app;
	const unseen = new Unseen({
		load: () => plugin.app.loadLocalStorage(STORAGE_KEY),
		save: (paths) => plugin.app.saveLocalStorage(STORAGE_KEY, paths),
	});
	plugin.registerEvent(
		workspace.on("file-open", (file) => file && unseen.drop(file.path)),
	);
	plugin.registerEvent(vault.on("delete", (file) => unseen.drop(file.path)));
	plugin.registerEvent(
		vault.on("rename", (file, from) => unseen.move(from, file.path)),
	);
	return unseen;
}

/** Only shares have other people; the note in front of the user is already seen. */
export function markTheirs(
	plugin: Plugin,
	unseen: Unseen,
	space: Space,
	paths: readonly string[],
): void {
	if (space.id === VAULT_SPACE.id) return;
	const active = plugin.app.workspace.getActiveFile()?.path;
	unseen.add(paths.filter((path) => path !== active));
}
