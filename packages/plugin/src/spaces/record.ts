import { isShareId, OWNER } from "@mdsync/protocol";

/**
 * Where a share's objects live: its owner's S3 location when it was created. Pinned for good; re-deriving
 * it from later settings would orphan them.
 */
export interface ShareLocation {
	endpoint: string;
	region: string;
	bucket: string;
	/** The owner's storage prefix; the share sits under `shares/<id>/` in it. */
	prefix: string;
	forcePathStyle: boolean;
}

export type ShareAccess =
	| {
			kind: "owner";
			location: ShareLocation;
			/** How participants see the owner; empty shows "Owner". */
			name?: string;
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
	/** Paused on every device of the person; one device alone is `pausedSpaces`. */
	paused?: true;
}

/** Last writer wins, deterministically on every device. */
export function isNewer(a: SpaceRecord, b: SpaceRecord): boolean {
	return a.rev !== b.rev ? a.rev > b.rev : a.author > b.author;
}

/** Outranks every edit made offline before the close; a join built on it still outranks it. */
const CLOSE_REV_STEP = 1_000_000;

/** A revision past any edit it did not see, closed; every device of the person unmounts it. */
export function closeRecord(record: SpaceRecord, author: string): SpaceRecord {
	return { ...record, rev: record.rev + CLOSE_REV_STEP, author, closed: true };
}

/** How a share names its owner, and a participant invited without a name. */
const OWNER_NAME = "Owner";
const UNNAMED = "Participant";

/** This device's person in the share: who the relay knows them as, and the name others see. */
export function shareIdentity(record: SpaceRecord): {
	person: string;
	name: string;
} {
	const { access } = record;
	return access.kind === "participant"
		? { person: access.participantId, name: access.personName || UNNAMED }
		: { person: OWNER, name: access.name || OWNER_NAME };
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
		isShareId(record.id) &&
		typeof record.name === "string" &&
		typeof record.root === "string" &&
		typeof record.author === "string" &&
		typeof record.key === "string" &&
		Number.isSafeInteger(record.rev) &&
		isAccess(record.access) &&
		(record.closed === undefined || record.closed === true) &&
		(record.paused === undefined || record.paused === true)
	);
}

function isAccess(value: unknown): value is ShareAccess {
	if (typeof value !== "object" || value === null) return false;
	const access = value as Record<string, unknown>;
	if (access.kind === "owner") {
		return (
			isLocation(access.location) &&
			(access.relayUrl === undefined || typeof access.relayUrl === "string") &&
			(access.name === undefined || typeof access.name === "string")
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
