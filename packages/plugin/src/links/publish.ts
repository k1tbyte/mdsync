import {
	deriveLinkKeys,
	fromBase64Url,
	LINK_MAX_SEALED_BYTES,
	type LinkPayload,
	linkUrl,
	newLinkId,
	newLinkKey,
	newLinkSalt,
	parseLinkLocation,
	sealLinkPayload,
	toBase64Url,
} from "@mdsync/protocol";
import type { TFile } from "obsidian";

import type { PluginHost } from "@/plugin/host";
import { isRelayConfigured, relayAdmin } from "@/settings/model";
import { relayBase } from "@/shared";
import { type BrokerAdmin, linkStatus, putLink, revokeLink } from "@/storage";
import { noteText } from "./note-text";
import { type LinkRecord, onRelay } from "./record";
import { type Snapshot, takeSnapshot } from "./snapshot";

export interface ShareOptions {
	/** Unix seconds; null never expires. */
	expires: number | null;
	maxViews: number | null;
	passphrase: string | null;
	images: boolean;
	/** Off publishes the note without its name. */
	title: boolean;
}

export const TOO_LARGE = "This note is too large to share as a link.";
const NO_RELAY = "Set up the relay under Connection to share links.";
const OTHER_RELAY =
	"This link was made through another relay: set that relay again to manage it.";
/** Ids of the links being updated now. */
const updating = new Set<string>();

/** What would be published, for the owner to look at first. */
export async function previewLink(
	plugin: PluginHost,
	file: TFile,
	images: boolean,
): Promise<Snapshot> {
	const takenAt = Date.now();
	const markdown = await noteText(plugin.app, file);
	const rendered = await takeSnapshot(plugin.app, file, markdown, { images });
	return { ...rendered, takenAt };
}

/** With the `snapshot` the owner looked at, that exact copy is what goes out. */
export async function publishLink(
	plugin: PluginHost,
	file: TFile,
	options: ShareOptions,
	snapshot?: Snapshot,
): Promise<LinkRecord> {
	if (!isRelayConfigured(plugin.settings)) throw new Error(NO_RELAY);
	// The address and the upload must name the same relay, whatever the settings become meanwhile.
	const admin = relayAdmin(plugin.settings);
	const id = newLinkId();
	const key = newLinkKey();
	const shot = snapshot ?? (await previewLink(plugin, file, options.images));
	const record: LinkRecord = {
		id,
		url: linkUrl(relayBase(admin.relayUrl), id, key),
		path: file.path,
		title: options.title ? file.basename : "",
		createdAt: Date.now(),
		publishedAt: shot.takenAt,
		expires: options.expires,
		maxViews: options.maxViews,
		salt: options.passphrase ? toBase64Url(newLinkSalt()) : null,
		images: options.images,
	};
	await upload({
		admin,
		file,
		record,
		key,
		passphrase: options.passphrase,
		update: false,
		snapshot: shot,
	});
	// A rename during the upload moved only the links already stored.
	const stored = { ...record, path: file.path };
	await plugin.sharedLinks.add(stored);
	return stored;
}

/** The same link, id and key, now showing the note as it is; views already spent stay spent. */
export async function updateLink(
	plugin: PluginHost,
	shown: LinkRecord,
	passphrase: string | null,
): Promise<void> {
	// Uploads can reach the relay in either order: a second one would leave the stale mark wrong.
	if (updating.has(shown.id)) throw new Error("This link is already updating.");
	updating.add(shown.id);
	try {
		// The note may have moved, or the link gone, while the passphrase was asked.
		const record = plugin.sharedLinks.all().find(({ id }) => id === shown.id);
		if (!record) throw new Error("This link is no longer shared.");
		const admin = adminFor(plugin, record);
		const file = plugin.app.vault.getFileByPath(record.path);
		if (!file) throw new Error(`The note is no longer at "${record.path}".`);
		const { hash, pathname } = new URL(record.url);
		const location = parseLinkLocation(pathname, hash);
		if (!location)
			throw new Error("This link's key is damaged. Create a new one.");
		const snapshot = await previewLink(plugin, file, record.images);
		await upload({
			admin,
			file,
			record,
			key: location.key,
			passphrase,
			update: true,
			snapshot,
		});
		await plugin.sharedLinks.published(record.id, snapshot.takenAt);
	} finally {
		updating.delete(shown.id);
	}
}

/** Ends the link at the relay, then forgets it here; unreachable, it stays listed to try again. */
export async function revokeLinkRecord(
	plugin: PluginHost,
	record: LinkRecord,
): Promise<void> {
	await revokeLink(adminFor(plugin, record), record.id);
	await plugin.sharedLinks.remove(record.id);
}

export async function linkStatusOf(plugin: PluginHost, record: LinkRecord) {
	return linkStatus(adminFor(plugin, record), record.id);
}

/** Asked again at each call: the relay in the settings may have changed since the list was drawn. */
function adminFor(plugin: PluginHost, record: LinkRecord): BrokerAdmin {
	if (!onRelay(record, plugin.settings)) throw new Error(OTHER_RELAY);
	return relayAdmin(plugin.settings);
}

async function upload(job: {
	admin: BrokerAdmin;
	file: TFile;
	record: LinkRecord;
	key: Uint8Array;
	passphrase: string | null;
	update: boolean;
	snapshot: Snapshot;
}): Promise<void> {
	const { admin, file, record, key, passphrase, update, snapshot } = job;
	const protection =
		record.salt && passphrase
			? { passphrase, salt: fromBase64Url(record.salt) }
			: undefined;
	if (record.salt && !protection)
		throw new Error("Enter the link's passphrase.");
	const keys = await deriveLinkKeys(key, protection);
	const payload: LinkPayload = {
		title: record.title && file.basename,
		html: snapshot.html,
		createdAt: Date.now(),
	};
	const sealed = await sealLinkPayload(record.id, payload, keys.content).catch(
		(error: unknown) => {
			throw error instanceof RangeError ? new Error(TOO_LARGE) : error;
		},
	);
	if (sealed.length > LINK_MAX_SEALED_BYTES) throw new Error(TOO_LARGE);
	await putLink(
		admin,
		record.id,
		sealed,
		{
			maxViews: record.maxViews,
			expires: record.expires,
			protection:
				keys.gate && record.salt
					? { gate: keys.gate, salt: record.salt }
					: null,
		},
		update,
	);
}
