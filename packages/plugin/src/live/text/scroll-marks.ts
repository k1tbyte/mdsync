import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { type LiveSession, LOCAL_AWARENESS } from "@/live/session";
import { personColor } from "@/shared";
import { cursorsIn, type RoomCursor } from "./cursors";
import type { TextModel } from "./model";

interface Mark {
	cursor: RoomCursor;
	/** Down the scroll range, as a CSS percentage. */
	top: string;
}

/** Others' cursors as ticks on the scrollbar; a tick scrolls to its cursor, never follows it. */
export function scrollMarks(session: LiveSession<TextModel>) {
	return ViewPlugin.define((view) => new ScrollMarks(view, session));
}

export class ScrollMarks {
	private readonly track: HTMLElement;
	/** A measure queued before the plugin went still runs after. */
	private destroyed = false;
	private marks: readonly Mark[] = [];
	private drawn = "[]";
	private readonly onAwareness = (_changes: unknown, origin: unknown): void => {
		if (origin !== LOCAL_AWARENESS) this.measure();
	};

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
				if (this.destroyed) return [];
				const cursors = cursorsIn(this.session);
				if (!cursors.length) return [];
				const { scrollDOM, state } = view;
				const height = scrollDOM.scrollHeight;
				if (height <= 0) return [];
				// Where the text starts in the scroll range: the title and properties sit above it.
				const start =
					view.documentTop -
					scrollDOM.getBoundingClientRect().top +
					scrollDOM.scrollTop;
				return cursors.map((cursor) => {
					const line = view.lineBlockAt(Math.min(cursor.at, state.doc.length));
					// Lines off screen have estimated heights.
					const top = Math.min(1, Math.max(0, (start + line.top) / height));
					return { cursor, top: `${(top * 100).toFixed(2)}%` };
				});
			},
			write: (marks) => {
				if (!this.destroyed) this.render(marks);
			},
		});
	}

	private render(marks: readonly Mark[]): void {
		this.marks = marks;
		const drawn = JSON.stringify(
			marks.map(({ cursor, top }) => [cursor.key, cursor.name, top]),
		);
		if (drawn === this.drawn) return;
		this.drawn = drawn;
		this.track.empty();
		marks.forEach(({ cursor, top }, index) => {
			const tick = this.track.createDiv({
				cls: "obsync-scroll-mark",
				attr: { "aria-label": cursor.name, "data-tooltip-position": "left" },
			});
			tick.setCssProps({ "--obsync-person": personColor(cursor.key) });
			tick.setCssStyles({ top });
			tick.addEventListener("click", () => this.reveal(index));
		});
	}

	private reveal(index: number): void {
		const mark = this.marks[index];
		if (!mark) return;
		this.view.dispatch({
			effects: EditorView.scrollIntoView(mark.cursor.at, { y: "center" }),
		});
	}
}
