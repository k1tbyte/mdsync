import {
	type EditorState,
	StateEffect,
	StateField,
	Text,
} from "@codemirror/state";
import { editorInfoField } from "obsidian";

import type { MarkedChange } from "./helpers";

export interface ChangesData {
	changes: readonly MarkedChange[];
	/** What they were computed for: a large edit recomputes them only later. */
	doc: Text;
	lastDiffMs: number;
}

const NO_CHANGES: ChangesData = { changes: [], doc: Text.empty, lastDiffMs: 0 };

export const setCompareTextEffect = StateEffect.define<Text | null>();
export const setChangesEffect = StateEffect.define<ChangesData>();

export const compareTextField = StateField.define<Text | null>({
	create: () => null,
	update(prev, tr) {
		if (pathFromState(tr.startState) !== pathFromState(tr.state)) {
			return null;
		}
		let next = prev;
		for (const effect of tr.effects) {
			if (effect.is(setCompareTextEffect)) next = effect.value;
		}
		return next;
	},
});

export const changesField = StateField.define<ChangesData>({
	create: () => NO_CHANGES,
	update(prev, tr) {
		if (pathFromState(tr.startState) !== pathFromState(tr.state)) {
			return NO_CHANGES;
		}
		let next = prev;
		for (const effect of tr.effects) {
			if (effect.is(setChangesEffect)) next = effect.value;
			if (effect.is(setCompareTextEffect)) next = NO_CHANGES;
		}
		return next;
	},
});

export function pathFromState(state: EditorState): string | null {
	try {
		// `editorInfoField` is undefined wherever the real Obsidian module is not
		// loaded, and `field` dereferences it before it can honour `require: false`.
		return state.field(editorInfoField, false)?.file?.path ?? null;
	} catch {
		return null;
	}
}
