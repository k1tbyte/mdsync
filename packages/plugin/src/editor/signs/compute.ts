import type { ChangeDesc } from "@codemirror/state";
import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { debounce } from "obsidian";

import { markedChanges } from "./helpers";
import {
	changesField,
	compareTextField,
	pathFromState,
	setChangesEffect,
	setCompareTextEffect,
} from "./state";

const DEBOUNCE_MS = 1000;
/** Marks follow typing at most this often: a diff per keystroke is wasted work on a phone. */
const TYPING_MS = 120;
const LARGE_CHANGE_THRESHOLD = 1000;
const SLOW_DIFF_THRESHOLD_MS = 16;

type Debounced = ReturnType<typeof debounce>;

export const computePlugin = ViewPlugin.fromClass(
	class {
		private readonly view: EditorView;
		private readonly debounced: Debounced;
		private readonly typing: Debounced;
		private lastChangeSize = 0;
		private scheduled = false;
		private destroyed = false;

		constructor(view: EditorView) {
			this.view = view;
			// Not reset per call: they fire once per window while edits keep coming.
			this.debounced = debounce(() => this.recompute(), DEBOUNCE_MS, false);
			this.typing = debounce(() => this.recompute(), TYPING_MS, false);
			this.scheduleRecompute();
		}

		update(u: ViewUpdate): void {
			let recomputeNow = false;
			const prevPath = pathFromState(u.startState);
			const nextPath = pathFromState(u.state);

			if (prevPath !== nextPath) {
				this.cancelPending();
			}

			if (u.docChanged && prevPath === nextPath) {
				this.lastChangeSize = changeSize(u.changes.desc);
				if (this.isQuickToRecompute()) {
					this.typing();
				} else {
					this.debounced();
				}
			}

			for (const tr of u.transactions) {
				for (const effect of tr.effects) {
					if (effect.is(setCompareTextEffect)) {
						recomputeNow = true;
					}
				}
			}

			if (recomputeNow) {
				this.cancelPending();
				this.scheduleRecompute();
			}
		}

		destroy(): void {
			this.destroyed = true;
			this.cancelPending();
		}

		private cancelPending(): void {
			this.debounced.cancel();
			this.typing.cancel();
		}

		private scheduleRecompute(): void {
			if (this.scheduled || this.destroyed) return;
			this.scheduled = true;
			const scheduledPath = pathFromState(this.view.state);
			queueMicrotask(() => {
				this.scheduled = false;
				if (this.destroyed) return;
				if (pathFromState(this.view.state) !== scheduledPath) return;
				this.recompute();
			});
		}

		private isQuickToRecompute(): boolean {
			const lastDiffMs = this.view.state.field(changesField).lastDiffMs;
			return (
				this.lastChangeSize <= LARGE_CHANGE_THRESHOLD &&
				lastDiffMs <= SLOW_DIFF_THRESHOLD_MS
			);
		}

		private recompute(): void {
			// It diffs the latest document, which any pending run would too.
			this.cancelPending();
			const state = this.view.state;
			const baseline = state.field(compareTextField);
			if (!baseline) {
				if (state.field(changesField).changes.length > 0) {
					this.view.dispatch({
						effects: setChangesEffect.of({
							changes: [],
							doc: state.doc,
							lastDiffMs: 0,
						}),
					});
				}
				return;
			}

			const current = state.doc;
			const start = performance.now();
			const changes = markedChanges(baseline, current);
			const elapsedMs = performance.now() - start;
			this.view.dispatch({
				effects: setChangesEffect.of({
					changes,
					doc: current,
					lastDiffMs: elapsedMs,
				}),
			});
		}
	},
);

function changeSize(changes: ChangeDesc): number {
	let total = 0;
	changes.iterChangedRanges((fromA, toA, fromB, toB) => {
		total += Math.max(toA - fromA, toB - fromB);
	});
	return total;
}
