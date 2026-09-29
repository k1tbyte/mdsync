/**
 * Each kind of live document in the view that edits it: a note in the
 * markdown editor's source mode, a drawing in the Excalidraw view. Sessions
 * see them only through `LiveEditor`, which hides the model behind the room.
 */

import { type FileView, MarkdownView, type TFile, type View } from "obsidian";

import { bindEditor } from "@/live/text/binding";
import { TEXT } from "@/live/text/model";
import { LIVE_VIEWS, type LiveDocKind } from "./doc-types";
import { bindDrawing } from "./drawing/binding";
import {
	drawingView,
	letWriteIn,
	readDrawing,
	saveDrawing,
} from "./drawing/excalidraw";
import { DRAWING } from "./drawing/model";
import type { BoundEditor, LiveKind, LiveModel } from "./model";
import { LiveSession, type LiveSessionDeps } from "./session";

/** A room, and how a view of its file binds to it. */
export interface LiveRoom {
	session: LiveSession;
	/** Null when `view` does not edit the file live, or is still loading; `onStale` asks for a new binding. */
	bind(view: View, me: string | null, onStale: () => void): BoundEditor | null;
}

export interface LiveEditor {
	viewType: string;
	/** The file `view` edits live now; null where it only shows it. */
	fileOf(view: View): TFile | null;
	/** What `view` holds of `path`, ahead of the file it saves a moment later. */
	read(view: View, path: string): string | null;
	/** False when `view` is not editing its file live now. */
	save(view: View): Promise<boolean>;
	/** The file sync is about to write `path`: `view`, if it shows it, takes the write in. */
	expectWrite(view: View, path: string): void;
	open(
		docId: string,
		generation: number,
		deps: Omit<LiveSessionDeps<LiveModel>, "kind">,
	): LiveRoom;
}

interface EditorSpec<V extends FileView, M extends LiveModel> {
	kind: LiveKind<M>;
	/** `view` narrowed, when it edits its file live now. */
	editing(view: View): V | null;
	/** Null while the view is loading: its file is as new. */
	read(view: V): string | null;
	save(view: V): Promise<void>;
	/** A write under the view would otherwise be lost to it. */
	expectWrite?(view: V): void;
	/** Null while the view is loading. */
	bind(
		view: V,
		session: LiveSession<M>,
		me: string | null,
		onStale: () => void,
	): BoundEditor | null;
}

export const EDITORS: Record<LiveDocKind, LiveEditor> = {
	// Obsidian merges a write under a note three-way with what its editor holds.
	text: liveEditor(LIVE_VIEWS.text, {
		kind: TEXT,
		editing: (view) =>
			view instanceof MarkdownView && view.getMode() === "source" ? view : null,
		read: (view) => view.editor.getValue(),
		save: (view) => view.save(),
		bind: bindEditor,
	}),
	drawing: liveEditor(LIVE_VIEWS.drawing, {
		kind: DRAWING,
		editing: drawingView,
		read: readDrawing,
		save: saveDrawing,
		expectWrite: letWriteIn,
		bind: (view, session, _me, onStale) => bindDrawing(view, session, onStale),
	}),
};

function liveEditor<V extends FileView, M extends LiveModel>(
	viewType: string,
	spec: EditorSpec<V, M>,
): LiveEditor {
	return {
		viewType,
		fileOf: (view) => spec.editing(view)?.file ?? null,
		read(view, path) {
			const editing = spec.editing(view);
			return editing?.file?.path === path ? spec.read(editing) : null;
		},
		async save(view) {
			const editing = spec.editing(view);
			if (!editing) return false;
			await spec.save(editing);
			return true;
		},
		expectWrite(view, path) {
			const editing = spec.editing(view);
			if (editing?.file?.path === path) spec.expectWrite?.(editing);
		},
		open(docId, generation, deps) {
			const session = new LiveSession(docId, generation, {
				...deps,
				kind: spec.kind,
			});
			return {
				session,
				bind(view, me, onStale) {
					const editing = spec.editing(view);
					return editing && spec.bind(editing, session, me, onStale);
				},
			};
		},
	};
}
