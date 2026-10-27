/**
 * One unit of file sync: the vault, or a shared folder with its own storage and key. Every path belongs to
 * exactly one space.
 */

export interface Space {
	id: string;
	/** Vault folder the space covers; "" for the vault itself. */
	root: string;
	/** Pulled, never pushed by itself: its storage refuses this device's writes. */
	readOnly?: true;
	/** Not synced on this device; its root still stays out of the vault. */
	paused?: true;
	/** For one operation: the person chose to publish the loss of every file it had. */
	goneAccepted?: true;
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

/** A vault path as the space names it on every device: without its mount. */
export function insideOf(space: Pick<Space, "root">, path: string): string {
	return space.root === "" ? path : path.slice(space.root.length + 1);
}

export function vaultPathOf(
	space: Pick<Space, "root">,
	inside: string,
): string {
	return space.root === "" ? inside : `${space.root}/${inside}`;
}

/** A share whose files all vanished on this device: syncing it would delete them for everyone. */
export class SpaceGoneError extends Error {
	constructor(root: string) {
		super(
			`"${root}" lost every file it had on this device, so it is not synced here.`,
		);
		this.name = "SpaceGoneError";
	}
}

/** Throws when a share's scan holds none of the files its baseline does; the vault is left alone. */
export function assertSpacePresent(
	space: Space,
	local: {
		files: Record<string, unknown>;
		skipped?: readonly { path: string }[];
	},
	baseline: { files: Record<string, unknown> } | null,
): void {
	if (space.root === VAULT_SPACE.root || space.goneAccepted) return;
	const known = Object.keys(baseline?.files ?? {}).filter((path) =>
		isUnder(path, space.root),
	);
	if (known.length === 0) return;
	// A new file does not bring the folder back: the rest would still be deleted for everyone.
	const skipped = new Set(local.skipped?.map(({ path }) => path));
	if (known.some((path) => path in local.files || skipped.has(path))) return;
	throw new SpaceGoneError(space.root);
}
