import { relayBase } from "@/shared";

const MS_PER_S = 1000;

/** One share link this device published. */
export interface LinkRecord {
	id: string;
	/** The whole link, key included: the only way to copy it again. */
	url: string;
	/** Where the note was when last shared; a rename in Obsidian updates it. */
	path: string;
	title: string;
	/** Milliseconds. */
	createdAt: number;
	/** Milliseconds; the last create or update. A note modified later shows a changed copy. */
	publishedAt: number;
	/** Unix seconds; null never expires. */
	expires: number | null;
	maxViews: number | null;
	/** base64url; set exactly when the link has a passphrase. An update needs it to seal again. */
	salt: string | null;
	/** Whether its images went along: an update keeps the owner's choice. */
	images: boolean;
}

export function isLinkRecord(value: unknown): value is LinkRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.id === "string" &&
		typeof record.url === "string" &&
		typeof record.path === "string" &&
		typeof record.title === "string" &&
		typeof record.createdAt === "number" &&
		typeof record.publishedAt === "number" &&
		(record.expires === null || typeof record.expires === "number") &&
		(record.maxViews === null || typeof record.maxViews === "number") &&
		(record.salt === null || typeof record.salt === "string") &&
		typeof record.images === "boolean"
	);
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
	try {
		return (
			new URL(record.url).origin === new URL(relayBase(relay.relayUrl)).origin
		);
	} catch {
		return false;
	}
}

/** The links after a note, or the folder holding it, moved; null when none was affected. */
export function renamedLinks(
	links: readonly LinkRecord[],
	from: string,
	to: string,
): LinkRecord[] | null {
	let moved = false;
	const next = links.map((record) => {
		const path =
			record.path === from
				? to
				: record.path.startsWith(`${from}/`)
					? to + record.path.slice(from.length)
					: null;
		if (path === null) return record;
		moved = true;
		return { ...record, path };
	});
	return moved ? next : null;
}
