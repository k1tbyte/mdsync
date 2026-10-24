import {
	type Extension,
	RangeSetBuilder,
	StateEffect,
	StateField,
} from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import type { ChunkMark } from "./helpers";

/** The change under the pointer and the one whose popup is open: their marks widen, the open one tints its lines. */
export interface HunkFocus {
	hover: ChunkMark | null;
	open: ChunkMark | null;
}

export const focusHunk = StateEffect.define<Partial<HunkFocus>>();

const NONE: HunkFocus = { hover: null, open: null };

export const hunkFocusField = StateField.define<HunkFocus>({
	create: () => NONE,
	update(prev, tr) {
		// An edit moves the lines a mark names.
		let next = tr.docChanged ? NONE : prev;
		for (const effect of tr.effects)
			if (effect.is(focusHunk)) next = { ...next, ...effect.value };
		return next;
	},
});

export function sameMark(a: ChunkMark | null, b: ChunkMark | null): boolean {
	return a === b || (!!a && !!b && a.from === b.from && a.to === b.to);
}

const openTint = EditorView.decorations.compute([hunkFocusField], (state) => {
	const { open } = state.field(hunkFocusField);
	if (!open) return Decoration.none;
	const builder = new RangeSetBuilder<Decoration>();
	const tint = Decoration.line({ class: `mdsync-hunk-open is-${open.kind}` });
	for (let n = open.from; n <= Math.min(open.to, state.doc.lines); n++) {
		const { from } = state.doc.line(n);
		builder.add(from, from, tint);
	}
	return builder.finish();
});

export const hunkFocus: Extension = [hunkFocusField, openTint];
