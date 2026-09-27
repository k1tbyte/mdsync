import type { LiveKeys } from "@/crypto/live-keys";

import { docIdFor } from "./seal";

/** How this device shows up in a room: its cursor, and the name its text carries. */
export interface LiveUser {
	name: string;
	color: string;
	colorLight: string;
}

/** Where a note goes live: the vault or a share, with that space's keys and the person typing in it. */
export interface LiveSpace {
	id: string;
	root: string;
	keys: LiveKeys;
	/** Who the relay knows this device's person as there: attribution names them so. */
	person: string;
	user: LiveUser;
}

/** Named by the path inside its space, so every mount of a share meets in one room. */
export function docIdIn(
	space: Pick<LiveSpace, "keys" | "root">,
	path: string,
	generation: number,
): Promise<string> {
	const inside = space.root === "" ? path : path.slice(space.root.length + 1);
	return docIdFor(space.keys, inside, generation);
}

export function sameSpace(a: LiveSpace, b: LiveSpace): boolean {
	return (
		a.id === b.id &&
		a.root === b.root &&
		a.keys === b.keys &&
		a.person === b.person &&
		a.user.name === b.user.name
	);
}
