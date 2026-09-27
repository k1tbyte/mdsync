import type { Menu } from "obsidian";

import type { PluginHost } from "@/plugin/host";
import { isRelayConfigured, ownerStorage } from "@/settings/model";
import { createShare } from "@/spaces/owner";
import { mountError } from "@/spaces/partition";
import type { SpaceRecord } from "@/spaces/record";
import { endShare, leaveShare } from "@/storage";

import { carryVaultIgnores } from "./ignore-action";
import { notifyError, notifyInfo } from "./notices";
import { pushScope } from "./push-action";
import { openConfirmModal } from "./source-control/modals";

/** Folder right-click entry: the folder becomes a space of its own, beside the vault. */
export function addShareMenuItem(
	menu: Menu,
	plugin: PluginHost,
	root: string,
): void {
	if (!ownerStorage(plugin.settings)) return;
	menu.addItem((item) =>
		item
			.setTitle("Obsync: Share folder")
			.setIcon("folder-symlink")
			.onClick(() => void shareFolder(plugin, root)),
	);
}

async function shareFolder(plugin: PluginHost, root: string): Promise<void> {
	const storage = ownerStorage(plugin.settings);
	if (!storage) return;
	const error = mountError(root, plugin.spaces.partition());
	if (error) return notifyInfo(error);
	if (!(await carryVaultIgnores(plugin, root))) return;
	const device = plugin.controller.currentDevice().id;
	await plugin.spaces.add(createShare(root, device, storage));
	await plugin.ignoreState.refresh();
	notifyInfo(`"${root}" is now a shared folder.`);
	await pushScope(plugin, root, true);
}

/**
 * The owner stops sharing, or a participant leaves. Files stay: the folder
 * syncs with this vault again from the next refresh, on every device of this person.
 */
export async function closeShare(
	plugin: PluginHost,
	record: SpaceRecord,
): Promise<void> {
	const { access } = record;
	const owner = access.kind === "owner";
	const action = owner ? "Stop sharing" : "Leave";
	const confirmed = await openConfirmModal({
		app: plugin.app,
		title: `${action} "${record.name}"?`,
		body: [
			owner
				? "Everyone you invited loses access to this folder, and its copy in your storage, history included, is deleted."
				: "You stop receiving this folder's changes.",
			`The files in "${record.root}" stay and sync with this vault again.`,
		],
		confirmLabel: action,
		confirmClass: "mod-warning",
	});
	if (!confirmed) return;
	// Tokens left live would keep writing where nobody reads.
	if (owner && isRelayConfigured(plugin.settings)) {
		const { relayUrl, relaySecret } = plugin.settings;
		try {
			await endShare({ relayUrl, secret: relaySecret }, record.id);
		} catch (err) {
			return notifyError("Could not stop sharing", err);
		}
	}
	// Leaving never waits on the owner's relay: the token is the owner's to end too.
	if (access.kind === "participant") {
		await leaveShare(access).catch((err) =>
			notifyError("The owner's relay did not hear you leave", err),
		);
	}
	await plugin.spaces.close(record.id, plugin.controller.currentDevice().id);
	notifyInfo(`"${record.root}" is no longer shared.`);
	// Out of the partition first: an operation queued for it is refused rather
	// than push its objects back. Its state goes too, or opening it again
	// elsewhere would read this baseline.
	await plugin.controller.refresh();
	await plugin.controller
		.forgetSpace({ id: record.id, root: record.root }, { deleteRemote: owner })
		.catch((err) =>
			notifyError("The shared folder's copy stayed in your storage", err),
		);
}
