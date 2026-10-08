import {
	deriveLinkKeys,
	fromBase64Url,
	LINK_MAX_SEALED_BYTES,
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
import {
	type BrokerAdmin,
	createLink,
	linkStatus,
	replaceLink,
	revokeLink,
} from "@/storage";
import { noteText } from "./note-text";
import { type LinkRecord, onRelay } from "./record";
import { type Snapshot, takeSnapshot } from "./snapshot";

export interface ShareOptions {
	/** Seconds from now, counted by the relay; null never expires. */
	ttl: number | null;
	maxViews: number | null;
	passphrase: string | null;
	/** Off publishes the note without its name. */
	showTitle: boolean;
}

export const TOO_LARGE = "This note is too large to share as a link.";
export const NO_RELAY = "Set up the relay under Connection to share links.";
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

/** The `snapshot` the owner looked at is exactly what goes out. */
export async function publishLink(
	plugin: PluginHost,
	file: TFile,
	options: ShareOptions,
	snapshot: Snapshot,
): Promise<LinkRecord> {
	if (!isRelayConfigured(plugin.settings)) throw new Error(NO_RELAY);
	// The address and the upload must name the same relay, whatever the settings become meanwhile.
	const admin = relayAdmin(plugin.settings);
	const id = newLinkId();
	const key = newLinkKey();
	const salt = options.passphrase ? toBase64Url(newLinkSalt()) : null;
	const sealed = await sealNote({
		id,
		key,
		salt,
		passphrase: options.passphrase,
		title: options.showTitle ? file.basename : "",
		snapshot,
	});
	const expires = await createLink(admin, id, sealed.bytes, {
		maxViews: options.maxViews,
		ttl: options.ttl,
		gate: sealed.gate,
		salt,
	});
	const record: LinkRecord = {
		id,
		url: linkUrl(relayBase(admin.relayUrl), id, key),
		// A rename during the upload moved only the links already stored.
		path: file.path,
		showTitle: options.showTitle,
		createdAt: Date.now(),
		publishedAt: snapshot.takenAt,
		expires,
		maxViews: options.maxViews,
		salt,
		images: snapshot.images,
		// A deletion during the upload came before the record: a note made at that path since is another.
		detached: plugin.app.vault.getFileByPath(file.path) !== file,
	};
	try {
		await plugin.sharedLinks.add(record);
	} catch (err) {
		// Without the record the key is lost and nothing here could ever stop the link. If it cannot be
		// stopped now either, the record stays in memory for the next save and a retry.
		await revokeLink(admin, id)
			.then(() => plugin.sharedLinks.remove(id))
			.catch(() => undefined);
		throw err;
	}
	return record;
}

/** Snapshots taken for one batch of updates, by whether they carry images: a note is drawn at most twice. */
export type RenderedNote = Map<boolean, Promise<Snapshot>>;

/**
 * The same link, id and key, now showing the note as it is; views already spent stay spent. Updating several
 * links of one note can share `rendered`.
 */
export async function updateLink(
	plugin: PluginHost,
	shown: LinkRecord,
	passphrase: string | null,
	rendered: RenderedNote = new Map(),
): Promise<void> {
	// Uploads can reach the relay in either order: a second one would leave the stale mark wrong.
	if (updating.has(shown.id)) throw new Error("This link is already updating.");
	updating.add(shown.id);
	try {
		// The note may have moved, or the link gone, while the passphrase was asked.
		const record = plugin.sharedLinks.all().find(({ id }) => id === shown.id);
		if (!record) throw new Error("This link is no longer shared.");
		if (record.detached) throw new Error("The note was deleted.");
		const admin = adminFor(plugin, record);
		const file = plugin.app.vault.getFileByPath(record.path);
		if (!file) throw new Error(`The note is no longer at "${record.path}".`);
		const { hash, pathname } = new URL(record.url);
		const location = parseLinkLocation(pathname, hash);
		if (!location)
			throw new Error("This link's key is damaged. Create a new one.");
		const drawn =
			rendered.get(record.images) ?? previewLink(plugin, file, record.images);
		rendered.set(record.images, drawn);
		const snapshot = await drawn;
		const sealed = await sealNote({
			id: record.id,
			key: location.key,
			salt: record.salt,
			passphrase,
			title: record.showTitle ? file.basename : "",
			snapshot,
		});
		await replaceLink(admin, record.id, sealed.bytes, sealed.gate);
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

async function sealNote(job: {
	id: string;
	key: Uint8Array;
	/** Set exactly when the link has a passphrase, which is then needed. */
	salt: string | null;
	passphrase: string | null;
	title: string;
	snapshot: Snapshot;
}): Promise<{ bytes: Uint8Array<ArrayBuffer>; gate: string }> {
	const { id, key, salt, passphrase, title, snapshot } = job;
	const protection =
		salt && passphrase ? { passphrase, salt: fromBase64Url(salt) } : undefined;
	if (salt && !protection) throw new Error("Enter the link's passphrase.");
	const keys = await deriveLinkKeys(key, protection);
	const bytes = await sealLinkPayload(
		id,
		{ title, html: snapshot.html, createdAt: snapshot.takenAt },
		keys.content,
	).catch((error: unknown) => {
		throw error instanceof RangeError ? new Error(TOO_LARGE) : error;
	});
	if (bytes.length > LINK_MAX_SEALED_BYTES) throw new Error(TOO_LARGE);
	return { bytes, gate: keys.gate };
}
