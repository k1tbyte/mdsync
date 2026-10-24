import {
	type EditorState,
	RangeSet,
	RangeSetBuilder,
	StateField,
} from "@codemirror/state";
import { type EditorView, GutterMarker, gutter } from "@codemirror/view";

import { focusHunk, hunkFocusField, sameMark } from "./focus";
import { type ChunkMark, chunkMarks, findChunkForLine } from "./helpers";
import { showHunkPopupAt } from "./hunk-popup";
import type { SignsProvider } from "./provider";
import {
	type ChunksData,
	chunksField,
	compareTextField,
	setChunksEffect,
	setCompareTextEffect,
} from "./state";

const ESignKind = {
	Add: "add",
	Change: "change",
	Delete: "delete",
	TopDelete: "topdelete",
	ChangeDelete: "changedelete",
} as const;
type ESignKind = (typeof ESignKind)[keyof typeof ESignKind];

const KIND_CLASS: Record<ESignKind, string> = {
	[ESignKind.Add]: "mdsync-sign-add",
	[ESignKind.Change]: "mdsync-sign-change",
	[ESignKind.Delete]: "mdsync-sign-delete",
	[ESignKind.TopDelete]: "mdsync-sign-topdelete",
	[ESignKind.ChangeDelete]: "mdsync-sign-changedelete",
};

class SignMarker extends GutterMarker {
	constructor(
		private readonly kind: ESignKind,
		private readonly wide: boolean,
	) {
		super();
	}

	override eq(other: GutterMarker): boolean {
		return (
			other instanceof SignMarker &&
			other.kind === this.kind &&
			other.wide === this.wide
		);
	}

	override toDOM(): HTMLElement {
		const cls = `mdsync-sign ${KIND_CLASS[this.kind]}`;
		return createDiv({ cls: this.wide ? `${cls} is-wide` : cls });
	}
}

const SIGN_MARKERS = Object.fromEntries(
	Object.values(ESignKind).map((kind) => [
		kind,
		[new SignMarker(kind, false), new SignMarker(kind, true)],
	]),
) as Record<ESignKind, [SignMarker, SignMarker]>;

const EMPTY_RANGE_SET = RangeSet.empty as RangeSet<GutterMarker>;

export const signsField = StateField.define<RangeSet<GutterMarker>>({
	create: (state) => buildMarkers(state),
	update(prev, tr) {
		const chunksUpdated = tr.effects.some((e) => e.is(setChunksEffect));
		const baseUpdated = tr.effects.some((e) => e.is(setCompareTextEffect));
		const prevChunks = tr.startState.field(chunksField, false);
		const nextChunks = tr.state.field(chunksField, false);
		const prevBase = tr.startState.field(compareTextField, false);
		const nextBase = tr.state.field(compareTextField, false);
		if (
			!chunksUpdated &&
			!baseUpdated &&
			prevChunks === nextChunks &&
			prevBase === nextBase
		) {
			// The chunk set has not been recomputed yet, but the document moved:
			// unmapped ranges would point past the end and the gutter would throw.
			if (tr.docChanged) return prev.map(tr.changes);
			const focusMoved =
				tr.startState.field(hunkFocusField, false) !==
				tr.state.field(hunkFocusField, false);
			if (!focusMoved) return prev;
		}
		return buildMarkers(tr.state);
	},
});

export function buildSignsGutter(provider: SignsProvider) {
	return gutter({
		class: "mdsync-sign-gutter",
		markers: (view: EditorView) => view.state.field(signsField),
		domEventHandlers: {
			mousedown: (view, block, event) => {
				if (!(event instanceof MouseEvent) || event.button !== 0) return false;
				const data = view.state.field(chunksField, false);
				if (!data || data.chunks.length === 0) return false;
				const lineNumber = view.state.doc.lineAt(block.from).number;
				return showHunkPopupAt(view, lineNumber, event, provider);
			},
			mousemove: (view, block) => {
				hover(view, view.state.doc.lineAt(block.from).number);
				return false;
			},
			mouseleave: (view) => {
				hover(view, null);
				return false;
			},
		},
	});
}

/** The line and diff last looked up per editor: a move within that line, against that diff, needs no lookup. */
const hovered = new WeakMap<
	EditorView,
	{ line: number | null; data: ChunksData | undefined }
>();

/** A whole change widens under the pointer, not just the line it is on. */
function hover(view: EditorView, line: number | null): void {
	const data = view.state.field(chunksField, false);
	const last = hovered.get(view);
	if (last?.line === line && last.data === data) return;
	hovered.set(view, { line, data });
	const baseline = view.state.field(compareTextField, false);
	const mark =
		line !== null && baseline && data?.doc === view.state.doc
			? (findChunkForLine(data.chunks, baseline, view.state.doc, line)?.mark ??
				null)
			: null;
	const focus = view.state.field(hunkFocusField, false);
	if (!focus || sameMark(focus.hover, mark)) return;
	view.dispatch({ effects: focusHunk.of({ hover: mark }) });
}

function buildMarkers(state: EditorState): RangeSet<GutterMarker> {
	const baseline = state.field(compareTextField, false);
	const data = state.field(chunksField, false);
	if (!baseline || !data || data.chunks.length === 0) return EMPTY_RANGE_SET;

	const builder = new RangeSetBuilder<GutterMarker>();
	const lastLine = state.doc.lines;
	let lastLineAdded = -1;

	const focus = state.field(hunkFocusField, false);
	const addSign = (line: number, kind: ESignKind, wide: boolean) => {
		if (line < 1 || line > lastLine) return;
		if (line <= lastLineAdded) return;
		lastLineAdded = line;
		const from = state.doc.line(line).from;
		builder.add(from, from, SIGN_MARKERS[kind][wide ? 1 : 0]);
	};

	for (const { mark } of chunkMarks(data.chunks, baseline, state.doc)) {
		const wide =
			!!focus && (sameMark(mark, focus.hover) || sameMark(mark, focus.open));
		for (let line = mark.from; line <= mark.to; line++)
			addSign(line, signKind(mark, line), wide);
	}

	return lastLineAdded > -1 ? builder.finish() : EMPTY_RANGE_SET;
}

/** One colour down a change, so a block reads as one stroke; its last line may also mark lines removed below. */
function signKind(mark: ChunkMark, line: number): ESignKind {
	if (mark.kind === "add") return ESignKind.Add;
	if (mark.kind === "delete") return ESignKind.Delete;
	if (mark.kind === "topdelete") return ESignKind.TopDelete;
	return mark.removesBelow && line === mark.to
		? ESignKind.ChangeDelete
		: ESignKind.Change;
}
