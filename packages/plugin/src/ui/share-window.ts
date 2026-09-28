import type { Menu } from "obsidian";

import type { PluginHost } from "@/plugin/host";
import { isRelayConfigured, ownerStorage } from "@/settings/model";
import type { SpaceRecord } from "@/spaces/record";
import { listParticipants, revokeParticipant } from "@/storage";
import type { Space } from "@/sync/space";

import { createInvite } from "./invite-action";
import { type ShareAccess, ShareModal } from "./modals";
import { closeShare, shareFolder } from "./share-action";
import { openConfirmModal } from "./source-control/modals";

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
	if (!ownerStorage(plugin.settings)) return;
	menu.addItem((item) =>
		item
			.setTitle("Obsync: Share folder")
			.setIcon("folder-symlink")
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
	const { people, hub } = plugin.realtime;
	const { vault, workspace } = plugin.app;
	const owner = record.access.kind === "owner";
	const space = plugin.spaces.partition().find(({ id }) => id === record.id);
	new ShareModal(plugin.app, {
		name: record.name,
		summary: summaryOf(plugin, record, space),
		here: () => (hub.carries(record.id) ? people.online(record.id) : null),
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

function summaryOf(
	plugin: PluginHost,
	record: SpaceRecord,
	space: Space | undefined,
): string {
	if (!space) {
		return `Not syncing: another shared folder already holds "${record.root}".`;
	}
	const { access } = record;
	const whose =
		access.kind === "owner"
			? "Yours"
			: `Shared with you${access.readOnly ? ", read-only" : ""}`;
	const relay =
		access.kind === "owner" && !isRelayConfigured(plugin.settings)
			? " Set up the relay to invite people."
			: "";
	return `${whose}, in "${record.root}".${relay}`;
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
