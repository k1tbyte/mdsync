import type { LiveKeys } from "@/crypto/live-keys";

import { docIdFor } from "./seal";

/** How this device shows up in a room: its cursor, and the name its text carries. */
export interface LiveUser {
	/** The presence key: whose cursor this is, for a jump to it. */
	key: string;
	name: string;
	color: string;
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

/** A vault path as the space names it on every device: without its mount. */
export function insideOf(space: Pick<LiveSpace, "root">, path: string): string {
	return space.root === "" ? path : path.slice(space.root.length + 1);
}

export function vaultPathOf(
	space: Pick<LiveSpace, "root">,
	inside: string,
): string {
	return space.root === "" ? inside : `${space.root}/${inside}`;
}

export function sameSpace(a: LiveSpace, b: LiveSpace): boolean {
	return (
		a.id === b.id &&
		a.root === b.root &&
		a.keys === b.keys &&
		a.person === b.person &&
		a.user.name === b.user.name &&
		a.readOnly === b.readOnly
	);
}
