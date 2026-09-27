import { hasDotSegment } from "@/shared/path";
import { isUnder, type Space, VAULT_SPACE } from "@/sync/space";

import type { SpaceRecord } from "./record";

/**
 * The vault, then every open record whose root is free. Roots never overlap: two
 * devices that shared one folder offline both keep the smaller id's space, and
 * the other stays out until its owner closes it. A paused share stays in,
 * so its folder stays out of the vault.
 */
export function spacesOf(
	records: readonly SpaceRecord[],
	paused: ReadonlySet<string> = new Set(),
): Space[] {
	const spaces: Space[] = [VAULT_SPACE];
	const byId = [...records].sort((a, b) => (a.id < b.id ? -1 : 1));
	for (const { id, root, closed, access } of byId) {
		if (closed || mountError(root, spaces) !== null) continue;
		spaces.push({
			id,
			root,
			...(access.kind === "participant" && access.readOnly
				? { readOnly: true }
				: {}),
			...(paused.has(id) ? { paused: true } : {}),
		});
	}
	return spaces;
}

/** Why no space can be mounted at `root` beside `spaces`, or null when it can. */
export function mountError(
	root: string,
	spaces: readonly Space[],
): string | null {
	if (root === "") return "The vault itself cannot be shared.";
	if (hasDotSegment(root)) return "Hidden folders cannot be shared.";
	const overlaps = spaces.some(
		(space) =>
			space.root !== "" &&
			(isUnder(root, space.root) || isUnder(space.root, root)),
	);
	return overlaps ? "This folder is in a shared folder or holds one." : null;
}
