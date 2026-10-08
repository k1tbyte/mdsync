import { FileView, type Plugin, type WorkspaceLeaf } from "obsidian";

import { noteLinks, noteLinksText } from "@/links";
import type { PluginHost } from "@/plugin/host";

import { openManageLinks } from "./link-menu";

interface Shown {
	view: FileView;
	path: string;
	el: HTMLElement;
}

export function registerNoteLinkActions(plugin: Plugin & PluginHost): void {
	const { workspace, vault } = plugin.app;
	const shown = new Map<WorkspaceLeaf, Shown>();
	let disposed = false;

	const refresh = (): void => {
		if (disposed) return;
		const seen = new Set<WorkspaceLeaf>();
		workspace.iterateAllLeaves((leaf) => {
			const { view } = leaf;
			if (!(view instanceof FileView) || view.file?.extension !== "md") return;
			const file = view.file;
			const links = noteLinks(plugin, file.path);
			if (!links) return;
			seen.add(leaf);
			let entry = shown.get(leaf);
			if (
				entry?.view !== view ||
				entry.path !== file.path ||
				!entry.el.parentElement
			) {
				entry?.el.remove();
				const el = view.addAction("globe", noteLinksText(links), () =>
					openManageLinks(plugin, file.path),
				);
				el.addClass("mdsync-published-action");
				entry = { view, path: file.path, el };
				shown.set(leaf, entry);
			}
			entry.el.setAttr("aria-label", noteLinksText(links));
			entry.el.toggleClass("is-stale", links.stale);
		});
		for (const [leaf, { el }] of shown) {
			if (seen.has(leaf)) continue;
			el.remove();
			shown.delete(leaf);
		}
	};

	plugin.register(plugin.sharedLinks.subscribe(refresh));
	plugin.registerEvent(workspace.on("layout-change", refresh));
	plugin.registerEvent(workspace.on("file-open", refresh));
	// A sync pull modifies thousands of notes; only a shared one can change its mark.
	plugin.registerEvent(
		vault.on("modify", (file) => {
			if (plugin.sharedLinks.of(file.path).length > 0) refresh();
		}),
	);
	plugin.registerEvent(vault.on("rename", refresh));
	plugin.register(() => {
		disposed = true;
		for (const { el } of shown.values()) el.remove();
		shown.clear();
	});
	workspace.onLayoutReady(refresh);
}
