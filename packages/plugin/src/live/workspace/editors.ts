/**
 * Each kind of live document in the view that edits it: a note in the markdown
 * editor's source mode, a drawing in Excalidraw. Sessions see them only through `LiveEditor`.
 */

import {
	type App,
	type FileView,
	MarkdownView,
	type TFile,
	type View,
	type WorkspaceLeaf,
} from "obsidian";
import { LIVE_VIEWS, type LiveDocKind, liveKindOf } from "@/live/doc-types";
import { bindDrawing } from "@/live/drawing/binding";
import {
	drawingView,
	letWriteIn,
	readDrawing,
	saveDrawing,
} from "@/live/drawing/excalidraw";
import { DRAWING } from "@/live/drawing/model";
import type { BoundEditor, LiveKind, LiveModel } from "@/live/model";
import { FollowerSession, LiveSession } from "@/live/session";
import type { LiveSessionDeps } from "@/live/session/session-deps";
import { bindEditor } from "@/live/text/binding";
import { TEXT } from "@/live/text/model";
import type { LiveSpace } from "./space";

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
	/** Whether a file with `disk` holds what a room `agreed`. */
	holds(agreed: string, disk: string): boolean;
	open(
		docId: string,
		generation: number,
		deps: Omit<LiveSessionDeps<LiveModel>, "kind">,
	): LiveRoom;
}

/** A file a view edits live now, and the space it goes live in. */
export interface OpenNote {
	file: TFile;
	space: LiveSpace;
	editor: LiveEditor;
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
		holds: (agreed, disk) => spec.kind.holds(agreed, disk),
		open(docId, generation, deps) {
			const { follower } = deps;
			const session = follower
				? new FollowerSession(docId, generation, {
						...deps,
						kind: spec.kind,
						follower,
					})
				: new LiveSession(docId, generation, { ...deps, kind: spec.kind });
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

export async function openNotes(
	app: App,
	liveSpace: (path: string) => Promise<LiveSpace | null>,
): Promise<Map<WorkspaceLeaf, OpenNote>> {
	const open = new Map<WorkspaceLeaf, OpenNote>();
	for (const [kind, editor] of Object.entries(EDITORS)) {
		for (const leaf of app.workspace.getLeavesOfType(editor.viewType)) {
			const file = editor.fileOf(leaf.view);
			if (!file || liveKindOf(app, file) !== kind) continue;
			const space = await liveSpace(file.path);
			// Readers follow notes only: a drawing's binding writes what its view reports.
			if (!space || (space.readOnly && kind !== "text")) continue;
			open.set(leaf, { file, space, editor });
		}
	}
	return open;
}

/** An open view is newer than the file it saves a moment later. */
export async function readOpen(
	app: App,
	path: string,
	editor: LiveEditor,
): Promise<string> {
	const { workspace, vault } = app;
	for (const leaf of workspace.getLeavesOfType(editor.viewType)) {
		const text = editor.read(leaf.view, path);
		if (text !== null) return text;
	}
	const file = vault.getFileByPath(path);
	// Gone mid-join: an empty text would read as everything deleted, and the join fails instead.
	if (!file) throw new Error(`No live note at ${path}`);
	return vault.read(file);
}
