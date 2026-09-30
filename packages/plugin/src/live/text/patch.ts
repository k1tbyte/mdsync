import { diffChars } from "diff";
import type * as Y from "yjs";

import { commonEnds, MAX_EDIT_LENGTH } from "@/sync/hunks";

const MIN_ANCHOR = 10;

interface Group {
	keep: string;
	removed: string;
	added: string;
}

const opsOf = ({ removed, added }: Group): number =>
	(removed ? 1 : 0) + (added ? 1 : 0);

/**
 * Brings a Y.Text to `target` as inserts and deletes: replacing the whole text
 * would make two devices that each rewrote it merge into interleaved nonsense.
 * Past the edit budget the differing middle becomes one replacement.
 */
export function patchYText(doc: Y.Doc, text: Y.Text, target: string): void {
	const current = text.toString();
	if (current === target) return;

	// Code points, not UTF-16 units: Yjs turns a split surrogate pair into U+FFFD.
	const a = Array.from(current);
	const b = Array.from(target);
	const { head, tail } = commonEnds(a, b);
	const from = a.slice(head, a.length - tail).join("");
	const to = b.slice(head, b.length - tail).join("");
	const parts = diffChars(from, to, { maxEditLength: MAX_EDIT_LENGTH }) ?? [
		{ removed: true, value: from },
		{ added: true, value: to },
	];

	const groups: Group[] = [];
	let keep = "";
	for (const part of parts) {
		if (!part.added && !part.removed) {
			keep += part.value;
			continue;
		}
		let group = groups.at(-1);
		if (keep || !group) {
			group = { keep, removed: "", added: "" };
			groups.push(group);
			keep = "";
		}
		if (part.added) group.added += part.value;
		else group.removed += part.value;
	}

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
		let at = a.slice(0, head).join("").length;
		for (const group of folded) {
			at += group.keep.length;
			if (group.removed) text.delete(at, group.removed.length);
			if (group.added) text.insert(at, group.added);
			at += group.added.length;
		}
	});
}
