import { ViewPlugin } from "@codemirror/view";

/**
 * Obsidian moves a tab's DOM to a popout as is, and CodeMirror mounts its styles only in the document it started in.
 * Watched on the host: Obsidian marks a watched node with a class, and CodeMirror rewrites its own root's.
 */
export const followWindow = (host: HTMLElement) =>
	ViewPlugin.define((view) => ({
		destroy: host.onWindowMigrated(() => view.setRoot(host.doc)),
	}));
