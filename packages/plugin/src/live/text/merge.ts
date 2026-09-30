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
	for (const region of threeWayRegions(baseLines, ourLines, roomLines, false)) {
		out.push(...baseLines.slice(cursor, region.base[0]));
		const mine = ourLines.slice(...region.local);
		const theirs = roomLines.slice(...region.remote);
		if (!region.changed.local) out.push(...theirs);
		else if (!region.changed.remote || sameLines(mine, theirs))
			out.push(...mine);
		else out.push(...keepBoth(theirs, mine));
		cursor = region.base[1];
	}
	out.push(...baseLines.slice(cursor));
	return out.join("\n");
}

/** Lines both sides open or close with come once, as git's zealous merge: two inserts at one spot often share them. */
function keepBoth(theirs: string[], mine: string[]): string[] {
	const shortest = Math.min(theirs.length, mine.length);
	let head = 0;
	while (head < shortest && theirs[head] === mine[head]) head++;
	let tail = 0;
	while (
		tail < shortest - head &&
		theirs[theirs.length - 1 - tail] === mine[mine.length - 1 - tail]
	) {
		tail++;
	}
	return [
		...theirs.slice(0, theirs.length - tail),
		...mine.slice(head, mine.length - tail),
		...theirs.slice(theirs.length - tail),
	];
}
