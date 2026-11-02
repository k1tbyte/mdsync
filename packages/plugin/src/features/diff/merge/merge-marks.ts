import type { EMergeSide, MergeChange, Span } from "@/features/sync";
import { type LineMarks, lineMarks } from "../lines/code-lines";

/** Word marks of a side's lines against the base lines of the same change; none where the side did not change. */
export type SideMarks = (
	change: MergeChange,
	side: EMergeSide,
) => ((offset: number) => readonly Span[]) | undefined;

/**
 * One marks function per change side for the session: ranges never move, so lines are diffed once and
 * blocks keep identity.
 */
export function sideMarks(
	base: readonly string[],
	sides: Record<EMergeSide, readonly string[]>,
): SideMarks {
	const cache = new Map<string, (offset: number) => readonly Span[]>();
	return (change, side) => {
		if (change.status[side] === "none") return undefined;
		const key = `${change.index}:${side}`;
		let marks = cache.get(key);
		if (!marks) {
			const lines: LineMarks[] = [];
			const [baseStart] = change.base;
			const [sideStart] = change[side];
			marks = (offset) => {
				lines[offset] ??= lineMarks(
					base[baseStart + offset],
					sides[side][sideStart + offset],
				);
				return lines[offset].added;
			};
			cache.set(key, marks);
		}
		return marks;
	};
}
