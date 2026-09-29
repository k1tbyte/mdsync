import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { LiveSession } from "@/live/session";
import { personColors } from "@/shared/colors";
import { cursorsIn, type RoomCursor } from "./cursors";
import type { TextModel } from "./model";

interface Mark {
	cursor: RoomCursor;
	/** Down the scroll range, 0 to 1. */
	top: number;
}

/** Others' cursors as ticks on the scrollbar; a tick scrolls to its cursor, never follows it. */
export function scrollMarks(session: LiveSession<TextModel>) {
	return ViewPlugin.define((view) => new ScrollMarks(view, session));
}

class ScrollMarks {
	private readonly track: HTMLElement;
	/** A measure queued before the plugin went still runs after. */
	private destroyed = false;
	private readonly onAwareness = (): void => this.measure();

	constructor(
		private readonly view: EditorView,
		private readonly session: LiveSession<TextModel>,
	) {
		this.track = view.dom.createDiv({ cls: "obsync-scroll-marks" });
		session.awareness.on("change", this.onAwareness);
		this.measure();
	}

	update(update: ViewUpdate): void {
		if (update.docChanged || update.geometryChanged) this.measure();
	}

	destroy(): void {
		this.destroyed = true;
		this.session.awareness.off("change", this.onAwareness);
		this.track.remove();
	}

	private measure(): void {
		this.view.requestMeasure({
			key: this,
			read: (view): Mark[] => {
				const { scrollDOM, state } = view;
				const height = scrollDOM.scrollHeight;
				if (this.destroyed || height <= 0) return [];
				// Where the text starts in the scroll range: the title and properties sit above it.
				const start =
					view.documentTop -
					scrollDOM.getBoundingClientRect().top +
					scrollDOM.scrollTop;
				return cursorsIn(this.session).map((cursor) => {
					const line = view.lineBlockAt(Math.min(cursor.at, state.doc.length));
					// Lines off screen have estimated heights.
					const top = Math.min(1, Math.max(0, (start + line.top) / height));
					return { cursor, top };
				});
			},
			write: (marks) => {
				if (!this.destroyed) this.render(marks);
			},
		});
	}

	private render(marks: readonly Mark[]): void {
		this.track.empty();
		for (const { cursor, top } of marks) {
			const tick = this.track.createDiv({
				cls: "obsync-scroll-mark",
				attr: { "aria-label": cursor.name, "data-tooltip-position": "left" },
			});
			tick.setCssProps({ "--obsync-person": personColors(cursor.key).color });
			tick.setCssStyles({ top: `${(top * 100).toFixed(2)}%` });
			tick.addEventListener("click", () =>
				this.view.dispatch({
					effects: EditorView.scrollIntoView(cursor.at, { y: "center" }),
				}),
			);
		}
	}
}
