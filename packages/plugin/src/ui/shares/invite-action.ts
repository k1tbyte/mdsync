import { TFile, TFolder } from "obsidian";

import { randomId } from "@/crypto";
import type { PluginHost } from "@/plugin/host";
import { ownerStorage } from "@/settings/model";
import { normalizePath, stripTrailingSlash } from "@/shared/path";
import {
	acceptInvite,
	brokerStorage,
	type Invite,
	inviteAccess,
	inviteLink,
	invitePassword,
	mountError,
	readInvite,
} from "@/spaces";
import type { SpaceRecord } from "@/spaces/record";
import {
	issueShareToken,
	listParticipants,
	registerShareStorage,
	revokeParticipant,
} from "@/storage";
import { scopedPaths } from "@/ui/actions/push-action";
import { notifyInfo, runWithNotice } from "@/ui/common";
import { AcceptInviteModal } from "@/ui/modals";
import { relayAdmin } from "./share-action";

export interface CreatedInvite {
	link: string;
	password: string;
}

/** Opens an `obsidian://obsync-share` link, or asks for one when `link` is empty. */
export function openInvite(plugin: PluginHost, link = ""): void {
	new AcceptInviteModal(
		plugin.app,
		link,
		readInvite,
		(invite) => {
			const known = recordOf(plugin, invite);
			return known && !known.closed ? known.root : null;
		},
		(invite, root) =>
			mountShare(plugin, invite, stripTrailingSlash(normalizePath(root))),
	).open();
}

/** Registered again on every invite, so the relay signs with current credentials. */
export async function createInvite(
	plugin: PluginHost,
	record: SpaceRecord,
	person: string,
	readOnly: boolean,
): Promise<CreatedInvite> {
	const s3 = ownerStorage(plugin.settings);
	if (!s3 || record.access.kind !== "owner") {
		throw new Error("Invites need this vault on S3.");
	}
	const { relayUrl } = plugin.settings;
	const admin = relayAdmin(plugin.settings);
	await registerShareStorage(
		admin,
		record.id,
		brokerStorage(record.access.location, s3),
	);
	const [again, ...older] = (await listParticipants(admin, record.id)).filter(
		(each) => sameName(each.label, person),
	);
	// The same person keeps their id: the broker swaps their token and the old link dies.
	const participantId = again?.id ?? randomId();
	const token = await issueShareToken(admin, {
		shareId: record.id,
		participantId,
		label: person,
		readOnly,
	});
	for (const each of older) await revokeParticipant(admin, record.id, each.id);
	const device = plugin.controller.currentDevice().id;
	await plugin.spaces.invitedVia(record.id, relayUrl, device);
	const password = invitePassword();
	const { id, name, key } = record;
	const link = await inviteLink(
		{
			id,
			name,
			key,
			relayUrl,
			token,
			participantId,
			personName: person,
			readOnly,
		},
		password,
	);
	return { link, password };
}

/** What is wrong with mounting at `root`, or null once the share is in. */
export async function mountShare(
	plugin: PluginHost,
	invite: Invite,
	root: string,
): Promise<string | null> {
	const known = recordOf(plugin, invite);
	// Closed too: accepting would turn the owner's record into a participant's.
	if (known?.access.kind === "owner") return "This shared folder is yours.";
	const device = plugin.controller.currentDevice().id;
	if (known && !known.closed) {
		// A new link, as after the owner's relay moved: same folder and baseline.
		await plugin.spaces.renew(invite.id, inviteAccess(invite), device);
		notifyInfo(`"${invite.name}" now syncs through the new link.`);
		void plugin.controller.refresh();
		return null;
	}
	const error = mountError(root, plugin.spaces.partition());
	if (error) return error;
	const existing = plugin.app.vault.getAbstractFileByPath(root);
	if (existing instanceof TFile) return "A file already has this name.";
	// Its files would be pushed into someone else's folder.
	if (existing instanceof TFolder && existing.children.length > 0) {
		return "This folder is not empty.";
	}
	if (!existing) await plugin.app.vault.createFolder(root);
	await plugin.spaces.add(acceptInvite(invite, root, device, known));
	await plugin.controller.forgetSpace({ id: invite.id, root });
	notifyInfo(`"${invite.name}" is now shared into "${root}".`);
	if (!plugin.settings.realtimeSync) {
		notifyInfo(
			"Turn on Real-time sync in the settings to see who is here and follow edits live.",
		);
	}
	void pullFolder(plugin, root);
	return null;
}

async function pullFolder(plugin: PluginHost, root: string): Promise<void> {
	await plugin.controller.refresh();
	const diff = plugin.controller.getSnapshot().result?.diff;
	const paths = scopedPaths(diff?.remoteChanges ?? [], root, true);
	if (paths.length === 0) return;
	await runWithNotice(
		() => plugin.controller.pullPaths(paths),
		`Pulled ${paths.length} file(s) into "${root}".`,
		"Could not pull the shared folder",
	);
}

function recordOf(plugin: PluginHost, invite: Invite): SpaceRecord | undefined {
	return plugin.spaces.list().find((record) => record.id === invite.id);
}

function sameName(a: string, b: string): boolean {
	const name = b.trim().toLowerCase();
	return name !== "" && a.trim().toLowerCase() === name;
}
