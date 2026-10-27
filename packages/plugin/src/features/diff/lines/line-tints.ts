import {
	type Extension,
	type Range,
	RangeSet,
	StateEffect,
	StateField,
	type Text,
} from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	type EditorView,
	GutterMarker,
	gutterLineClass,
	type PluginValue,
	ViewPlugin,
	type ViewUpdate,
} from "@codemirror/view";

/** A row's tint: on its line, and on its gutter elements beside it. */
export interface Tints {
	lines: Range<Decoration>[];
	gutter: Range<GutterMarker>[];
}

/** The line decoration alone stops at the line numbers. */
class GutterClass extends GutterMarker {
	constructor(elementClass: string) {
		super();
		this.elementClass = elementClass;
	}

	eq(other: GutterMarker): boolean {
		return other.elementClass === this.elementClass;
	}
}

/** A changed row, tinted across its line number; `lineExtra` styles the line alone. */
export function tintLine(
	tints: Tints,
	at: number,
	state: string,
	lineExtra = "",
): void {
	tints.lines.push(
		Decoration.line({ class: `mdsync-diff-line ${state}${lineExtra}` }).range(
			at,
		),
	);
	tints.gutter.push(new GutterClass(`mdsync-diff-gutter ${state}`).range(at));
}

/** A notch where lines of the other pane land: an empty range still shows. */
export function markLine(
	tints: Tints,
	doc: Text,
	at: number,
	state: string,
): void {
	const line = doc.lineAt(Math.min(at, doc.length));
	const after = at === line.from ? "" : " is-after";
	tints.lines.push(
		Decoration.line({ class: `mdsync-diff-mark ${state}${after}` }).range(
			line.from,
		),
	);
	tints.gutter.push(
		new GutterClass(`mdsync-diff-gutter-mark ${state}${after}`).range(
			line.from,
		),
	);
}

/**
 * Tints built for the viewport alone; a big diff has far more changed lines than a screen. `gutterLineClass`
 * only takes state, so the plugin hands its gutter marks over through a field of its own.
 */
export function viewportTints(
	build: (view: EditorView, tints: Tints) => void,
	stale: (update: ViewUpdate) => boolean,
): Extension {
	const marksChanged = StateEffect.define<RangeSet<GutterMarker>>();
	const marksField = StateField.define<RangeSet<GutterMarker>>({
		create: () => RangeSet.empty,
		update(marks, transaction) {
			for (const effect of transaction.effects) {
				if (effect.is(marksChanged)) return effect.value;
			}
			return transaction.docChanged ? marks.map(transaction.changes) : marks;
		},
		provide: (field) => gutterLineClass.from(field),
	});

	class TintsPlugin implements PluginValue {
		decorations: DecorationSet = Decoration.none;
		private gutter = RangeSet.empty as RangeSet<GutterMarker>;
		private queued = false;
		private destroyed = false;

		constructor(view: EditorView) {
			this.build(view);
		}

		update(update: ViewUpdate): void {
			if (update.viewportChanged || stale(update)) this.build(update.view);
		}

		destroy(): void {
			this.destroyed = true;
		}

		private build(view: EditorView): void {
			const tints: Tints = { lines: [], gutter: [] };
			build(view, tints);
			this.decorations = Decoration.set(tints.lines, true);
			this.gutter = RangeSet.of(tints.gutter, true);
			if (this.queued) return;
			this.queued = true;
			// A plugin cannot dispatch while updating; a microtask lands before the next paint.
			queueMicrotask(() => {
				this.queued = false;
				if (!this.destroyed) {
					view.dispatch({ effects: marksChanged.of(this.gutter) });
				}
			});
		}
	}

	return [
		marksField,
		ViewPlugin.fromClass(TintsPlugin, {
			decorations: (plugin) => plugin.decorations,
		}),
	];
}
