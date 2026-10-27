import { isLinkId } from "@mdsync/protocol";

import { isCleartextRemote, relayBase } from "@/core/shared";
import type { Revised } from "@/core/utils";

const MS_PER_S = 1000;

/** One share link of this person, as every device of theirs trades it through the vault storage. */
export interface LinkRecord extends Revised {
	id: string;
	/** The whole link, key included: the only way to copy it again. */
	url: string;
	/** Where the note was when last shared; a rename in Obsidian updates it. */
	path: string;
	/** Whether the page carries the note's name; an update keeps the owner's choice. */
	showTitle: boolean;
	/** Milliseconds. */
	createdAt: number;
	/** Milliseconds; the last create or update. A note modified later shows a changed copy. */
	publishedAt: number;
	/** Unix seconds, as the relay set it; null never expires. */
	expires: number | null;
	maxViews: number | null;
	/** base64url; set exactly when the link has a passphrase. An update needs it to seal again. */
	salt: string | null;
	/** Whether its images went along: an update keeps the owner's choice. */
	images: boolean;
	/** The note was deleted: the link stays live and listed, but no note of that path feeds it any more. */
	detached: boolean;
}

/** This device's copy of a record; the extra fields never leave it. */
export interface StoredLink extends LinkRecord {
	/** Identity of the vault storage it was last traded with; unset until first published. */
	vault?: string;
	/** Removed here: hidden, until the next trade deletes it from the vault storage too. */
	removed?: true;
}

/** A record of the first builds, made before links were traded, starts at revision 0. */
export function parseStoredLink(value: unknown): StoredLink | null {
	const record = parseLinkRecord(value);
	if (!record) return null;
	const { vault, removed } = value as Record<string, unknown>;
	return {
		...record,
		...(typeof vault === "string" ? { vault } : {}),
		...(removed === true ? { removed } : {}),
	};
}

/** Another device's record: its id names the object it came in. */
export function parseTradedLink(value: unknown): LinkRecord | null {
	const record = parseLinkRecord(value);
	return record && isLinkId(record.id) ? record : null;
}

/** What goes to the vault storage: nothing only this device knows. */
export function tradedLink({
	vault: _,
	removed: __,
	...record
}: StoredLink): LinkRecord {
	return record;
}

/**
 * Keeps whatever a stored record still tells: the id and the link are all that stopping it takes, so a record
 * missing other fields is repaired rather than dropped with its key.
 */
function parseLinkRecord(value: unknown): LinkRecord | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	const { id, url, path } = record;
	if (typeof id !== "string" || typeof url !== "string") return null;
	return {
		id,
		url,
		rev: numberOr(record.rev, 0),
		author: typeof record.author === "string" ? record.author : "",
		path: typeof path === "string" ? path : "",
		// Records of the first builds kept the choice as `title`, empty when the name was hidden.
		showTitle:
			typeof record.showTitle === "boolean"
				? record.showTitle
				: record.title !== "",
		createdAt: numberOr(record.createdAt, 0),
		publishedAt: numberOr(record.publishedAt, 0),
		expires: numberOr(record.expires, null),
		maxViews: numberOr(record.maxViews, null),
		salt: typeof record.salt === "string" ? record.salt : null,
		images: record.images !== false,
		detached: record.detached === true || typeof path !== "string",
	};
}

function numberOr<T>(value: unknown, fallback: T): number | T {
	return typeof value === "number" ? value : fallback;
}

/** The note's name as last known: its file name without the extension. */
export function noteName(record: LinkRecord): string {
	return record.path
		.slice(record.path.lastIndexOf("/") + 1)
		.replace(/\.md$/, "");
}

/** The note changed after its last publish: the link shows an older copy. */
export function isStale(record: LinkRecord, mtime: number): boolean {
	return mtime > record.publishedAt;
}

/** Past its expiry the relay has erased it, whatever was last heard. */
export function isExpired(record: LinkRecord, now = Date.now()): boolean {
	return record.expires !== null && record.expires * MS_PER_S <= now;
}

/** Only the relay that holds a link can stop or update it. */
export function onRelay(
	record: LinkRecord,
	relay: { relayUrl: string; relaySecret: string },
): boolean {
	if (!relay.relayUrl || !relay.relaySecret) return false;
	if (isCleartextRemote(relay.relayUrl)) return false;
	try {
		return (
			new URL(record.url).origin === new URL(relayBase(relay.relayUrl)).origin
		);
	} catch {
		return false;
	}
}

/** The links after a note, or the folder holding it, moved; null when none was affected. */
export function renamedLinks<T extends LinkRecord>(
	links: readonly T[],
	from: string,
	to: string,
): T[] | null {
	return changedLinks(links, from, (record) => ({
		...record,
		path: to + record.path.slice(from.length),
	}));
}

/** The links after a note, or the folder holding it, was deleted; null when none was affected. */
export function detachedLinks<T extends LinkRecord>(
	links: readonly T[],
	path: string,
): T[] | null {
	return changedLinks(links, path, (record) => ({ ...record, detached: true }));
}

/** Applies `change` to the attached links at or under `path`; null when there were none. */
function changedLinks<T extends LinkRecord>(
	links: readonly T[],
	path: string,
	change: (record: T) => T,
): T[] | null {
	let touched = false;
	const next = links.map((record) => {
		const within = record.path === path || record.path.startsWith(`${path}/`);
		if (record.detached || !within) return record;
		touched = true;
		return change(record);
	});
	return touched ? next : null;
}
