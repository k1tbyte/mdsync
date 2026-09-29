import type { Menu } from "obsidian";

import type { PluginHost } from "@/plugin/host";
import { isRelayConfigured, ownerStorage } from "@/settings/model";
import type { SpaceRecord } from "@/spaces/record";
import { listParticipants, revokeParticipant } from "@/storage";
import type { Space } from "@/sync/space";
import { openConfirmModal } from "@/ui/source-control/modals";
import { createInvite } from "./invite-action";
import { closeShare, shareFolder } from "./share-action";
import { type ShareAccess, ShareModal } from "./share-modal";
import { presenceNote } from "./share-people";

/** Folder right-click entry: a shared folder's window, or sharing one, which then opens it. */
export function addShareMenuItem(
	menu: Menu,
	plugin: PluginHost,
	root: string,
): void {
	const shared = shareAt(plugin, root);
	if (shared) {
		menu.addItem((item) =>
			item
				.setTitle("Obsync: Manage sharing")
				.setIcon("users")
				.onClick(() => openShareWindow(plugin, shared)),
		);
		return;
	}
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
				const record = await shareFolder(plugin, root);
				if (record) openShareWindow(plugin, record);
			}),
	);
}

/** The share's window, for its owner and for whoever it was shared with. */
export function openShareWindow(
	plugin: PluginHost,
	record: SpaceRecord,
	onClosed?: () => void,
): void {
	const { people, statusOf } = plugin.realtime;
	const { vault, workspace } = plugin.app;
	const owner = record.access.kind === "owner";
	const space = plugin.spaces.partition().find(({ id }) => id === record.id);
	new ShareModal(plugin.app, {
		name: record.name,
		summary: summaryOf(record, space),
		here: () => people.online(record.id),
		note: () => presenceNote(statusOf(record.id), people.unreadable(record.id)),
		subscribe: (listener) => people.subscribe(listener),
		openNote: (path) => {
			const file = vault.getFileByPath(path);
			if (file) void workspace.getLeaf(false).openFile(file);
		},
		access:
			owner && isRelayConfigured(plugin.settings)
				? ownerAccess(plugin, record)
				: null,
		paused: space ? space.paused === true : null,
		setPaused: async (paused) => {
			await plugin.spaces.setPaused(record.id, paused);
			void plugin.controller.refresh();
		},
		closeLabel: owner ? "Stop sharing" : "Leave",
		close: () => closeShare(plugin, record),
		onClosed,
	}).open();
}

/** The open share mounted at `root`, if any. */
export function shareAt(
	plugin: PluginHost,
	root: string,
): SpaceRecord | undefined {
	return plugin.spaces
		.list()
		.find((record) => record.root === root && !record.closed);
}

function summaryOf(record: SpaceRecord, space: Space | undefined): string {
	if (!space) {
		return `Not syncing: another shared folder already holds "${record.root}".`;
	}
	const { access } = record;
	const whose =
		access.kind === "owner"
			? "Yours"
			: `Shared with you${access.readOnly ? ", read-only" : ""}`;
	return `${whose}, in "${record.root}".`;
}

function ownerAccess(plugin: PluginHost, record: SpaceRecord): ShareAccess {
	const { relayUrl, relaySecret } = plugin.settings;
	const admin = { relayUrl, secret: relaySecret };
	return {
		people: () => listParticipants(admin, record.id),
		revoke: async (person) => {
			const confirmed = await openConfirmModal({
				app: plugin.app,
				title: `Revoke ${person.label || "this person"}?`,
				body: [
					`They can no longer open "${record.name}". The files they already have stay with them.`,
				],
				confirmLabel: "Revoke",
				confirmClass: "mod-warning",
			});
			if (confirmed) await revokeParticipant(admin, record.id, person.id);
			return confirmed;
		},
		invite: (person, readOnly) =>
			createInvite(plugin, record, person, readOnly),
	};
}
