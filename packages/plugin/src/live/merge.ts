import { sameLines, threeWayRegions, toLines } from "@/sync/merge-model";

/**
 * The room's text with this device's offline changes folded in, on the same
 * regions the merge editor shows. Diffing the room straight to the disk would
 * express an overwrite as operations and delete everyone else's edits.
 *
 * A real conflict keeps both sides, the room's first: a visible duplicate
 * beats a silent deletion, and the room's side is what others already see.
 */
export function mergeThreeWay(
	base: string,
	ours: string,
	room: string,
): string {
	if (ours === base) return room;
	if (room === base || room === ours) return ours;

	const baseLines = toLines(base);
	const ourLines = toLines(ours);
	const roomLines = toLines(room);
	const out: string[] = [];
	let cursor = 0;
	for (const region of threeWayRegions(baseLines, ourLines, roomLines)) {
		out.push(...baseLines.slice(cursor, region.base[0]));
		const mine = ourLines.slice(...region.local);
		const theirs = roomLines.slice(...region.remote);
		if (!region.changed.local) out.push(...theirs);
		else if (!region.changed.remote || sameLines(mine, theirs))
			out.push(...mine);
		else out.push(...theirs, ...mine);
		cursor = region.base[1];
	}
	out.push(...baseLines.slice(cursor));
	return out.join("\n");
}
