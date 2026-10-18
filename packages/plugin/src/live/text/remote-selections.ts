import type { Range } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	type EditorView,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

class CaretWidget extends WidgetType {
	constructor(
		private readonly color: string,
		private readonly name: string,
	) {
		super();
	}

	toDOM(): HTMLElement {
		const caret = createSpan({ cls: "cm-ySelectionCaret" });
		caret.setCssStyles({
			backgroundColor: this.color,
			borderColor: this.color,
		});
		caret.append(
			"\u2060",
			createDiv({ cls: "cm-ySelectionCaretDot" }),
			"\u2060",
			createDiv({ cls: "cm-ySelectionInfo", text: this.name }),
			"\u2060",
		);
		return caret;
	}

	eq(other: CaretWidget): boolean {
		return other.color === this.color && other.name === this.name;
	}

	updateDOM(): boolean {
		return false;
	}

	get estimatedHeight(): number {
		return -1;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

/** What a peer publishes: awareness states are untyped. */
interface PeerState {
	cursor?: { anchor?: Y.RelativePosition; head?: Y.RelativePosition } | null;
	user?: { color?: string; colorLight?: string; name?: string };
}

/**
 * y-codemirror.next's remote selections, except that a selection costs only the lines on screen (the
 * library emits a decoration per selected line, offscreen included, on every update), and nothing is
 * rebuilt unless awareness, the document or the viewport changed.
 */
export function remoteSelections(ytext: Y.Text, awareness: Awareness) {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet = Decoration.none;
			private dirty = true;
			private readonly onChange = ({
				added,
				updated,
				removed,
			}: {
				added: number[];
				updated: number[];
				removed: number[];
			}) => {
				const me = awareness.doc.clientID;
				if (![...added, ...updated, ...removed].some((id) => id !== me)) return;
				this.dirty = true;
				this.view.dispatch({});
			};

			constructor(private readonly view: EditorView) {
				awareness.on("change", this.onChange);
			}

			destroy(): void {
				awareness.off("change", this.onChange);
			}

			update(update: ViewUpdate): void {
				this.publishLocal(update);
				if (!this.dirty && !update.docChanged && !update.viewportChanged)
					return;
				this.dirty = false;
				this.decorations = this.build(update.view);
			}

			private publishLocal(update: ViewUpdate): void {
				const local = awareness.getLocalState() as PeerState | null;
				if (local == null) return;
				const hasFocus =
					update.view.hasFocus && update.view.dom.ownerDocument.hasFocus();
				// Unfocused, the last cursor stays where it was, as the library leaves it.
				if (!hasFocus) return;
				const sel = update.state.selection.main;
				const anchor = Y.createRelativePositionFromTypeIndex(ytext, sel.anchor);
				const head = Y.createRelativePositionFromTypeIndex(ytext, sel.head);
				const { cursor } = local;
				if (
					cursor == null ||
					!Y.compareRelativePositions(
						Y.createRelativePositionFromJSON(cursor.anchor),
						anchor,
					) ||
					!Y.compareRelativePositions(
						Y.createRelativePositionFromJSON(cursor.head),
						head,
					)
				) {
					awareness.setLocalStateField("cursor", { anchor, head });
				}
			}

			private build(view: EditorView): DecorationSet {
				const doc = ytext.doc;
				const lines = view.state.doc;
				const out: Range<Decoration>[] = [];
				const states = awareness.getStates() as Map<number, PeerState>;
				for (const [id, state] of states) {
					const { cursor } = state;
					if (id === awareness.doc.clientID || !doc) continue;
					if (cursor?.anchor == null || cursor.head == null) continue;
					const anchor = Y.createAbsolutePositionFromRelativePosition(
						cursor.anchor,
						doc,
					);
					const head = Y.createAbsolutePositionFromRelativePosition(
						cursor.head,
						doc,
					);
					if (
						!anchor ||
						!head ||
						anchor.type !== ytext ||
						head.type !== ytext
					) {
						continue;
					}
					const { color = "#30bced", name = "Anonymous" } = state.user ?? {};
					const colorLight = state.user?.colorLight ?? `${color}33`;
					const start = Math.min(anchor.index, head.index);
					const end = Math.max(anchor.index, head.index);
					const first = lines.lineAt(start).number;
					const last = lines.lineAt(end).number;
					const style = `background-color: ${colorLight}`;
					const whole = Decoration.line({
						attributes: { style, class: "cm-yLineSelection" },
					});
					const part = Decoration.mark({
						attributes: { style },
						class: "cm-ySelection",
					});
					// A fold or line gap splits a line over several ranges: marks are clipped, a line marked once.
					let marked = 0;
					for (const range of view.visibleRanges) {
						const lo = Math.max(range.from, start);
						const hi = Math.min(range.to, end);
						if (lo > hi) continue;
						for (
							let line = lines.lineAt(lo);
							;
							line = lines.line(line.number + 1)
						) {
							if (line.number > first && line.number < last) {
								if (line.number > marked) out.push(whole.range(line.from));
								marked = line.number;
							} else {
								const from = Math.max(
									line.number === first ? start : line.from,
									lo,
								);
								const to = Math.min(line.number === last ? end : line.to, hi);
								if (from < to) out.push(part.range(from, to));
							}
							if (line.to >= hi) break;
						}
					}
					out.push(
						Decoration.widget({
							// The local cursor is rendered outside the remote selection.
							side: head.index - anchor.index > 0 ? -1 : 1,
							block: false,
							widget: new CaretWidget(color, name),
						}).range(head.index),
					);
				}
				return Decoration.set(out, true);
			}
		},
		{ decorations: (plugin) => plugin.decorations },
	);
}
