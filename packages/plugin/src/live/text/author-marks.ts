import {
	type Extension,
	RangeSetBuilder,
	StateEffect,
} from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	type EditorView,
	type PluginValue,
	ViewPlugin,
	type ViewUpdate,
} from "@codemirror/view";
import type * as Y from "yjs";
import { type Author, authorRanges } from "@/live/authors";
import { personColors } from "@/shared/colors";

/** Typing and scrolling recompute the tint at most this often; in between it is only mapped. */
const REDRAW_MS = 250;

const redraw = StateEffect.define<null>();

/** Tints what anyone but `me` typed in the visible part of the note; hovering names them. */
export function authorMarks(
	text: Y.Text,
	users: Y.Map<unknown>,
	me: string,
): Extension {
	class AuthorMarks implements PluginValue {
		decorations: DecorationSet;
		private timer: number | null = null;
		private readonly marks = new Map<string, Decoration>();

		constructor(view: EditorView) {
			this.decorations = this.build(view);
		}

		update(update: ViewUpdate): void {
			const due = update.transactions.some((tr) =>
				tr.effects.some((effect) => effect.is(redraw)),
			);
			if (due) {
				this.decorations = this.build(update.view);
				return;
			}
			if (!update.docChanged && !update.viewportChanged) return;
			this.decorations = this.decorations.map(update.changes);
			this.schedule(update.view);
		}

		destroy(): void {
			if (this.timer !== null) window.clearTimeout(this.timer);
		}

		private schedule(view: EditorView): void {
			this.timer ??= window.setTimeout(() => {
				this.timer = null;
				view.dispatch({ effects: redraw.of(null) });
			}, REDRAW_MS);
		}

		private build(view: EditorView): DecorationSet {
			// Mid-sync the room and the editor disagree on offsets: keep the mapped tint.
			if (text.length !== view.state.doc.length) {
				this.schedule(view);
				return this.decorations ?? Decoration.none;
			}
			const builder = new RangeSetBuilder<Decoration>();
			for (const { from, to, author } of authorRanges(
				text,
				users,
				view.visibleRanges,
				me,
			)) {
				builder.add(from, to, this.markOf(author));
			}
			return builder.finish();
		}

		private markOf({ person, name }: Author): Decoration {
			const key = `${person}\n${name}`;
			let mark = this.marks.get(key);
			if (!mark) {
				mark = Decoration.mark({
					attributes: {
						title: name,
						style: `background-color: ${personColors(person).colorLight}`,
					},
				});
				this.marks.set(key, mark);
			}
			return mark;
		}
	}
	return ViewPlugin.fromClass(AuthorMarks, {
		decorations: (plugin) => plugin.decorations,
	});
}
