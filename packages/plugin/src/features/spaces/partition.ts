import { hasDotSegment } from "@/core/shared";
import { isUnder, type Space, VAULT_SPACE } from "@/features/sync";

import type { SpaceRecord } from "./record";

/**
 * The vault, then every open record whose root is free; a paused share stays in, so its folder stays out of the vault.
 * Roots never overlap: if two devices shared one folder offline, the smaller id wins; the other stays out until closed.
 */
export function spacesOf(
	records: readonly SpaceRecord[],
	isPaused: (record: SpaceRecord) => boolean = () => false,
): Space[] {
	const spaces: Space[] = [VAULT_SPACE];
	const byId = [...records].sort((a, b) => (a.id < b.id ? -1 : 1));
	for (const record of byId) {
		const { id, root, closed, access } = record;
		if (closed || mountError(root, spaces) !== null) continue;
		spaces.push({
			id,
			root,
			...(access.kind === "participant" && access.readOnly
				? { readOnly: true }
				: {}),
			...(isPaused(record) ? { paused: true } : {}),
		});
	}
	return spaces;
}

/** Why this device holds a share out of sync: shares off here, paused on all the person's devices, or here. */
export type PauseKind = "off" | "everywhere" | "here";

export function pauseOf(
	record: SpaceRecord,
	settings: { useSharedFolders: boolean; pausedSpaces: readonly string[] },
): PauseKind | null {
	if (!settings.useSharedFolders) return "off";
	if (record.paused) return "everywhere";
	return settings.pausedSpaces.includes(record.id) ? "here" : null;
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
