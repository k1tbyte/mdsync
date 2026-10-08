import { type App, type Menu, type TAbstractFile, TFile } from "obsidian";

import { docKindOf } from "@/live";
import type { PluginHost } from "@/plugin/host";
import { isRelayConfigured } from "@/settings/model";
import { notifyInfo, RELAY_TEXT } from "@/ui/common";

import { ManageLinksModal } from "./manage-links-modal";
import { ShareLinkModal } from "./share-link-modal";

/** Excalidraw drawings are markdown on disk but render as their compressed data; the name covers unindexed ones. */
export function isLinkable(
	app: App,
	file: TAbstractFile | null,
): file is TFile {
	return (
		file instanceof TFile &&
		file.extension === "md" &&
		!file.name.endsWith(".excalidraw.md") &&
		docKindOf(app, file) !== "drawing"
	);
}

export function openShareLink(
	plugin: PluginHost,
	file: TFile,
	onCreated?: () => void,
): void {
	if (!isRelayConfigured(plugin.settings)) {
		notifyInfo(`${RELAY_TEXT["no-relay"]} to share links.`);
		return;
	}
	new ShareLinkModal(plugin, file, onCreated).open();
}

export function openManageLinks(plugin: PluginHost, path?: string): void {
	new ManageLinksModal(plugin, path).open();
}

export function addLinkMenuItems(
	menu: Menu,
	plugin: PluginHost,
	file: TAbstractFile,
): void {
	if (!isLinkable(plugin.app, file)) return;
	const ready = isRelayConfigured(plugin.settings);
	menu.addItem((item) =>
		item
			.setTitle(
				ready ? "MDSync: Share link" : "MDSync: Share link (needs a relay)",
			)
			.setIcon("link")
			.setDisabled(!ready)
			.onClick(() => openShareLink(plugin, file)),
	);
	const count = plugin.sharedLinks.of(file.path).length;
	if (count === 0) return;
	menu.addItem((item) =>
		item
			.setTitle(`MDSync: Share links of this note (${count})`)
			.setIcon("list")
			.onClick(() => openManageLinks(plugin, file.path)),
	);
}
