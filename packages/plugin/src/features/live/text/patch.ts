import type * as Y from "yjs";
import { changedMiddle, diffRanges } from "@/core/utils";
import { DIFF_BUDGET } from "@/features/sync";

const MIN_ANCHOR = 10;

interface Group {
	keep: string;
	removed: string;
	added: string;
}

const opsOf = ({ removed, added }: Group): number =>
	(removed ? 1 : 0) + (added ? 1 : 0);

/**
 * Brings a Y.Text to `target` as inserts and deletes: replacing the whole text would make two devices that
 * each rewrote it merge into interleaved nonsense. Past the diff budget the differing middle is one
 * replacement.
 */
export function patchYText(doc: Y.Doc, text: Y.Text, target: string): void {
	const current = text.toJSON();
	if (current === target) return;

	// Code points, not UTF-16 units: Yjs turns a split surrogate pair into U+FFFD.
	const a = Array.from(current);
	const b = Array.from(target);
	const ranges = diffRanges(a, b, DIFF_BUDGET) ?? [changedMiddle(a, b)];
	let kept = 0;
	const groups = ranges.map((range): Group => {
		const keep = a.slice(kept, range.a[0]).join("");
		kept = range.a[1];
		return {
			keep,
			removed: a.slice(...range.a).join(""),
			added: b.slice(...range.b).join(""),
		};
	});

	const folded: Group[] = [];
	for (const group of groups) {
		const left = folded.at(-1);
		if (
			left &&
			group.keep.length < MIN_ANCHOR &&
			opsOf(left) + opsOf(group) >= 3
		) {
			left.removed += group.keep + group.removed;
			left.added += group.keep + group.added;
		} else {
			folded.push(group);
		}
	}

	doc.transact(() => {
		let at = 0;
		for (const group of folded) {
			at += group.keep.length;
			if (group.removed) text.delete(at, group.removed.length);
			if (group.added) text.insert(at, group.added);
			at += group.added.length;
		}
	});
}
