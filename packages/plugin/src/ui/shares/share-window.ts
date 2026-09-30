import type { Menu } from "obsidian";

import type { PluginHost } from "@/plugin/host";
import { ownerStorage } from "@/settings/model";
import { mountError } from "@/spaces";
import type { SpaceRecord } from "@/spaces/record";
import { isUnder } from "@/sync/space";
import { notifyError } from "@/ui/common";
import { shareFolder } from "./share-action";
import { ShareModal } from "./share-modal";

/** Folder menu entry: the window of the share the folder is or is in, else sharing it. */
export function addShareMenuItem(
	menu: Menu,
	plugin: PluginHost,
	root: string,
): void {
	const shared = plugin.spaces
		.list()
		.find((record) => !record.closed && isUnder(root, record.root));
	if (shared) {
		menu.addItem((item) =>
			item
				.setTitle("Obsync: Manage sharing")
				.setIcon("users")
				.onClick(() => openShareWindow(plugin, shared)),
		);
		return;
	}
	if (mountError(root, plugin.spaces.partition())) return;
	const sharable = ownerStorage(plugin.settings) !== null;
	menu.addItem((item) =>
		item
			.setTitle(
				sharable
					? "Obsync: Share folder"
					: "Obsync: Share folder (needs S3 storage)",
			)
			.setIcon("folder-symlink")
			.setDisabled(!sharable)
			.onClick(async () => {
				try {
					const record = await shareFolder(plugin, root);
					if (record) openShareWindow(plugin, record);
				} catch (err) {
					notifyError("Could not share the folder", err);
				}
			}),
	);
}

/** The share's window, for its owner and for whoever it was shared with. */
export function openShareWindow(
	plugin: PluginHost,
	record: SpaceRecord,
	onClosed?: () => void,
): void {
	new ShareModal(plugin, record, onClosed).open();
}
