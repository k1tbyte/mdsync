import type { PluginHost } from "@/plugin/host";
import {
	isRelayConfigured,
	ownerStorage,
	type RelayConfig,
} from "@/settings/model";
import { relayBase } from "@/shared/path";
import { createShare, mountError } from "@/spaces";
import type { SpaceRecord } from "@/spaces/record";
import {
	type BrokerAdmin,
	endShare,
	leaveShare,
	type Participant,
	revokeParticipant,
} from "@/storage";
import { carryVaultIgnores } from "@/ui/actions/ignore-action";
import { pushScope } from "@/ui/actions/push-action";
import { notifyError, notifyInfo, RELAY_TEXT } from "@/ui/common";
import { openConfirmModal } from "@/ui/modals";

export function relayAdmin({
	relayUrl,
	relaySecret,
}: RelayConfig): BrokerAdmin {
	return { relayUrl, secret: relaySecret };
}

export function closeLabel({ access }: SpaceRecord): string {
	return access.kind === "owner" ? "Stop sharing" : "Leave";
}

/** The folder becomes a space of its own, beside the vault; null when it cannot. */
export async function shareFolder(
	plugin: PluginHost,
	root: string,
): Promise<SpaceRecord | null> {
	const storage = ownerStorage(plugin.settings);
	if (!storage) return null;
	const error = mountError(root, plugin.spaces.partition());
	if (error) {
		notifyInfo(error);
		return null;
	}
	if (!isRelayConfigured(plugin.settings)) {
		notifyInfo(
			`Shared with your own devices. ${RELAY_TEXT["no-relay"]} to invite people.`,
		);
	}
	if (!(await carryVaultIgnores(plugin, root))) return null;
	const device = plugin.controller.currentDevice().id;
	const record = createShare(root, device, storage);
	await plugin.spaces.add(record);
	await plugin.ignoreState.refresh();
	notifyInfo(`"${root}" is now a shared folder.`);
	void pushScope(plugin, root, true);
	return record;
}

/** The relay an owner's invites went through, when this vault cannot reach it to end their tokens. */
export function strandedInvites(
	plugin: PluginHost,
	record: SpaceRecord,
): string | null {
	const { access } = record;
	if (access.kind !== "owner" || access.relayUrl === undefined) return null;
	const reached =
		isRelayConfigured(plugin.settings) &&
		relayBase(plugin.settings.relayUrl) === relayBase(access.relayUrl);
	return reached ? null : access.relayUrl;
}

/** The owner stops sharing, or a participant leaves; true once it is closed. */
export async function closeShare(
	plugin: PluginHost,
	record: SpaceRecord,
): Promise<boolean> {
	const { access } = record;
	const owner = access.kind === "owner";
	const action = closeLabel(record);
	const stranded = strandedInvites(plugin, record);
	const confirmed = await openConfirmModal({
		app: plugin.app,
		title: `${action} "${record.name}"?`,
		body: [
			owner
				? "Everyone you invited loses access to this folder, and its copy in your storage, history included, is deleted."
				: "You stop receiving this folder's changes.",
			...(stranded
				? [
						`People were invited through ${stranded}, which this vault no longer uses: their links keep working there and what they write still reaches your storage. Set that relay again first to end their access.`,
					]
				: []),
			`The files in "${record.root}" stay and sync with this vault again.`,
		],
		confirmLabel: action,
		confirmClass: "mod-warning",
	});
	if (!confirmed) return false;
	// Live tokens would keep writing where nobody reads.
	if (owner && isRelayConfigured(plugin.settings)) {
		try {
			await endShare(relayAdmin(plugin.settings), record.id);
		} catch (err) {
			notifyError("Could not stop sharing", err);
			return false;
		}
	}
	// Leaving never waits on the owner's relay: the owner can end the token too.
	if (access.kind === "participant") {
		await leaveShare(access).catch((err) =>
			notifyError("The owner's relay did not hear you leave", err),
		);
	}
	await plugin.spaces.close(record.id, plugin.controller.currentDevice().id);
	notifyInfo(`"${record.root}" is no longer shared.`);
	// Out of the partition first, so a queued operation is refused rather than push objects back.
	// Its state goes too, or opening it elsewhere would read this baseline.
	await plugin.controller.refresh();
	await plugin.controller
		.forgetSpace({ id: record.id, root: record.root }, { deleteRemote: owner })
		.catch((err) =>
			notifyError("The shared folder's copy stayed in your storage", err),
		);
	return true;
}

/** False when the owner backed out. */
export async function revokeAccess(
	plugin: PluginHost,
	record: SpaceRecord,
	person: Participant,
): Promise<boolean> {
	const confirmed = await openConfirmModal({
		app: plugin.app,
		title: `Revoke ${person.label || "this person"}?`,
		body: [
			`They can no longer open "${record.name}". The files they already have stay with them.`,
		],
		confirmLabel: "Revoke",
		confirmClass: "mod-warning",
	});
	if (confirmed) {
		await revokeParticipant(relayAdmin(plugin.settings), record.id, person.id);
	}
	return confirmed;
}
