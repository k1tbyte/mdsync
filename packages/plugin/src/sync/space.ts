/**
 * A space is one unit of the file sync: the vault, or a shared folder with its
 * own storage and key. Every path belongs to exactly one space.
 */

export interface Space {
	id: string;
	/** Vault folder the space covers; "" for the vault itself. */
	root: string;
	/** Pulled, never pushed by itself: its storage refuses this device's writes. */
	readOnly?: true;
	/** Not synced on this device; its root still stays out of the vault. */
	paused?: true;
}

export const VAULT_SPACE: Space = { id: "vault", root: "" };

/** The space whose root holds the path: the deepest one, else the vault. */
export function spaceOf(spaces: readonly Space[], path: string): Space {
	let owner = VAULT_SPACE;
	for (const space of spaces) {
		if (isUnder(path, space.root) && space.root.length > owner.root.length) {
			owner = space;
		}
	}
	return owner;
}

export function pathsBySpace(
	spaces: readonly Space[],
	paths: Iterable<string>,
): Map<Space, string[]> {
	const groups = new Map<Space, string[]>();
	for (const path of paths) {
		const space = spaceOf(spaces, path);
		const group = groups.get(space);
		if (group) group.push(path);
		else groups.set(space, [path]);
	}
	return groups;
}

/** Roots of the other spaces inside this one: its scope leaves them out. */
export function nestedRoots(spaces: readonly Space[], space: Space): string[] {
	return spaces
		.filter(
			(other) => other.root !== space.root && isUnder(other.root, space.root),
		)
		.map((other) => other.root);
}

/** True for the root folder itself and anything inside it; everything is under "". */
export function isUnder(path: string, root: string): boolean {
	return root === "" || path === root || path.startsWith(`${root}/`);
}

/** A share whose folder vanished on this device: syncing it would delete it for everyone. */
export class SpaceGoneError extends Error {
	constructor(root: string) {
		super(
			`"${root}" is gone or empty on this device, so it is not synced here.`,
		);
		this.name = "SpaceGoneError";
	}
}

/** Throws when a share's scan found nothing its baseline still holds; the vault is left alone. */
export function assertSpacePresent(
	space: Space,
	local: { files: Record<string, unknown> },
	baseline: { files: Record<string, unknown> } | null,
): void {
	if (space.root === VAULT_SPACE.root) return;
	if (Object.keys(local.files).length > 0) return;
	const known = Object.keys(baseline?.files ?? {});
	if (!known.some((path) => isUnder(path, space.root))) return;
	throw new SpaceGoneError(space.root);
}
