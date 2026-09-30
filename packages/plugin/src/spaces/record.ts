/**
 * Where a share's objects live: its owner's S3 location when it was created.
 * Pinned for good; re-deriving it from later settings would orphan them.
 */
export interface ShareLocation {
	endpoint: string;
	region: string;
	bucket: string;
	/** The owner's storage prefix; the share sits under `shares/<id>/` in it. */
	prefix: string;
	forcePathStyle: boolean;
}

/** How this person reaches a share's objects. */
export type ShareAccess =
	| {
			kind: "owner";
			location: ShareLocation;
			/** Where the last invite went: participants' tokens live on that relay. */
			relayUrl?: string;
	  }
	/** Through the owner's relay, which presigns each request under `token`. */
	| {
			kind: "participant";
			relayUrl: string;
			token: string;
			/** The relay's name for this person, as its hub reports them to others. */
			participantId: string;
			/** What the owner called this person, possibly nothing. */
			personName: string;
			readOnly?: true;
	  };

/** A space other than the vault, as one person's devices know it. */
export interface SpaceRecord {
	id: string;
	name: string;
	/** Vault folder the space is mounted at on this person's devices. */
	root: string;
	/** Bumped by every edit: the higher one wins. */
	rev: number;
	/** Device that made this revision; breaks a tie in `rev`. */
	author: string;
	/** The share's own data key, base64. */
	key: string;
	access: ShareAccess;
	/** Stopped or left: a tombstone, since records are never deleted. The folder returns to the vault. */
	closed?: true;
}

/** Last writer wins, deterministically on every device. */
export function isNewer(a: SpaceRecord, b: SpaceRecord): boolean {
	return a.rev !== b.rev ? a.rev > b.rev : a.author > b.author;
}

/** The next revision, closed; every device of the person unmounts it. */
export function closeRecord(record: SpaceRecord, author: string): SpaceRecord {
	return { ...record, rev: record.rev + 1, author, closed: true };
}

/** Every id once, at its newest revision, sorted by id. */
export function mergeRecords(
	...lists: (readonly SpaceRecord[])[]
): SpaceRecord[] {
	const byId = new Map<string, SpaceRecord>();
	for (const record of lists.flat()) {
		const known = byId.get(record.id);
		if (!known || isNewer(record, known)) byId.set(record.id, record);
	}
	return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function isSpaceRecord(value: unknown): value is SpaceRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.id === "string" &&
		typeof record.name === "string" &&
		typeof record.root === "string" &&
		typeof record.author === "string" &&
		typeof record.key === "string" &&
		Number.isSafeInteger(record.rev) &&
		isAccess(record.access) &&
		(record.closed === undefined || record.closed === true)
	);
}

function isAccess(value: unknown): value is ShareAccess {
	if (typeof value !== "object" || value === null) return false;
	const access = value as Record<string, unknown>;
	if (access.kind === "owner") {
		return (
			isLocation(access.location) &&
			(access.relayUrl === undefined || typeof access.relayUrl === "string")
		);
	}
	return (
		access.kind === "participant" &&
		typeof access.relayUrl === "string" &&
		typeof access.token === "string" &&
		typeof access.participantId === "string" &&
		typeof access.personName === "string" &&
		(access.readOnly === undefined || access.readOnly === true)
	);
}

function isLocation(value: unknown): value is ShareLocation {
	if (typeof value !== "object" || value === null) return false;
	const location = value as Record<string, unknown>;
	return (
		typeof location.endpoint === "string" &&
		typeof location.region === "string" &&
		typeof location.bucket === "string" &&
		typeof location.prefix === "string" &&
		typeof location.forcePathStyle === "boolean"
	);
}
