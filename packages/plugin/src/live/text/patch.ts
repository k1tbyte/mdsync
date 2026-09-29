import { diffChars } from "diff";
import type * as Y from "yjs";

import { commonEnds, MAX_EDIT_LENGTH } from "@/sync/hunks";

/**
 * Brings a Y.Text to `target` as inserts and deletes. Replacing the whole text
 * instead would make two devices that each rewrote it merge into interleaved
 * nonsense - the rule the live layer rests on.
 *
 * Under the project's one edit budget; past it the differing middle becomes one
 * replacement, which still leaves the untouched ends alone.
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

	doc.transact(() => {
		let at = a.slice(0, head).join("").length;
		for (const part of parts) {
			if (part.added) {
				text.insert(at, part.value);
				at += part.value.length;
			} else if (part.removed) {
				text.delete(at, part.value.length);
			} else {
				at += part.value.length;
			}
		}
	});
}
