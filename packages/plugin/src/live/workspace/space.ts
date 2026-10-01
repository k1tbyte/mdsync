import type { LiveKeys } from "@/crypto/live-keys";
import { docIdFor } from "@/live/doc-id";
import { insideOf } from "@/sync/space";

export interface LiveUser {
	/** The presence key: whose cursor this is, for a jump to it. */
	key: string;
	name: string;
	color: string;
	/** Beside the name on its cursor: one person's devices share a key and colour. */
	device: string | null;
}

/** Where a note goes live: the vault or a share, with that space's keys and the person typing in it. */
export interface LiveSpace {
	id: string;
	root: string;
	keys: LiveKeys;
	/** Who the relay knows this device's person as there: attribution names them so. */
	person: string;
	user: LiveUser;
	/** A read-only share: its notes follow the room, never writing to it. */
	readOnly?: true;
}

/** Named by the path inside its space, so every mount of a share meets in one room. */
export function docIdIn(
	space: Pick<LiveSpace, "keys" | "root">,
	path: string,
	generation: number,
): Promise<string> {
	return docIdFor(space.keys, insideOf(space, path), generation);
}

export function sameSpace(a: LiveSpace, b: LiveSpace): boolean {
	return (
		a.id === b.id &&
		a.root === b.root &&
		a.keys === b.keys &&
		a.person === b.person &&
		a.user.name === b.user.name &&
		a.user.device === b.user.device &&
		a.readOnly === b.readOnly
	);
}
