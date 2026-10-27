import {
	Compartment,
	type Extension,
	Prec,
	StateEffect,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import type { Editor, MarkdownView } from "obsidian";
import {
	yCollab,
	yRemoteSelectionsTheme,
	yUndoManagerKeymap,
} from "y-codemirror.next";
import type * as Y from "yjs";
import { USERS } from "../authors";
import type { BoundEditor } from "../model";
import type { LiveSession } from "../session/session";
import { authorMarks } from "./author-marks";
import type { TextModel } from "./model";
import { remoteSelections } from "./remote-selections";
import { scrollMarks } from "./scroll-marks";

/**
 * Attaches a session to one leaf through a Compartment (`registerEditorExtension` reaches every editor); a
 * file switch replaces the EditorState, so the binding never carries another file's text into this room.
 * Reaches CodeMirror via Obsidian's undocumented `editor.cm`.
 */
export function bindEditor(
	view: MarkdownView,
	session: LiveSession<TextModel>,
	me: string | null,
): BoundEditor | null {
	const cm = (view.editor as unknown as { cm?: EditorView }).cm;
	if (!cm) return null;

	// Keystrokes typed while the room was answering go in before the editor follows it.
	session.adopt(view.editor.getValue());
	const text = session.model.text.toJSON();
	// Skipping the no-op keeps the cursor where the user left it.
	if (view.editor.getValue() !== text) view.editor.setValue(text);

	const compartment = new Compartment();
	const marks = new Compartment();
	const tint = (who: string | null): Extension =>
		who === null
			? []
			: authorMarks(
					session.model.text,
					session.doc.getMap(USERS),
					who,
					(person) => session.nameOf(person),
				);
	cm.dispatch({
		effects: StateEffect.appendConfig.of(
			compartment.of([
				// No awareness: the library's selection plugin redraws every selected line on each update.
				yCollab(session.model.text, null, {
					undoManager: session.model.undoManager,
				}),
				yRemoteSelectionsTheme,
				remoteSelections(session.model.text, session.awareness),
				// Obsidian's own undo would also revert what other devices typed.
				Prec.high([
					keymap.of(yUndoManagerKeymap),
					historyInput(session.model.undoManager),
				]),
				marks.of(tint(me)),
				scrollMarks(session),
			]),
		),
	});
	const apply = (effect: StateEffect<unknown>) => {
		try {
			cm.dispatch({ effects: effect });
		} catch {
			// The leaf was torn down before its binding.
		}
	};

	const restoreUndo = routeUndo(view.editor, session.model.undoManager);

	return {
		showAuthors: (who) => apply(marks.reconfigure(tint(who))),
		detach: () => {
			restoreUndo();
			apply(compartment.reconfigure([]));
			forgetView(session.model.undoManager, cm);
		},
	};
}

/** The library keys undo selections by a plugin holding its view, which would outlive the split in the shared history. */
export function forgetView(undoManager: Y.UndoManager, cm: EditorView): void {
	for (const item of [...undoManager.undoStack, ...undoManager.redoStack]) {
		for (const key of [...item.meta.keys()]) {
			if ((key as { view?: unknown })?.view === cm) item.meta.delete(key);
		}
	}
}

const HISTORY_INPUTS: Record<string, "undo" | "redo"> = {
	historyUndo: "undo",
	historyRedo: "redo",
};

/** The Edit menu and system gestures undo through `beforeinput`, which CodeMirror's history would take. */
function historyInput(undoManager: Y.UndoManager): Extension {
	return EditorView.domEventHandlers({
		beforeinput(event) {
			const step = HISTORY_INPUTS[event.inputType];
			if (!step) return false;
			event.preventDefault();
			undoManager[step]();
			return true;
		},
	});
}

const unrouted = new WeakMap<Editor, Pick<Editor, "undo" | "redo">>();

/** The phone toolbar's undo calls `editor.undo()`; routed to the room's history until detached. */
function routeUndo(editor: Editor, undoManager: Y.UndoManager): () => void {
	const own = unrouted.get(editor) ?? {
		undo: editor.undo.bind(editor),
		redo: editor.redo.bind(editor),
	};
	unrouted.set(editor, own);
	const routed = {
		undo: () => void undoManager.undo(),
		redo: () => void undoManager.redo(),
	};
	Object.assign(editor, routed);
	return () => {
		// A later binding may have routed it again.
		if (editor.undo === routed.undo) editor.undo = own.undo;
		if (editor.redo === routed.redo) editor.redo = own.redo;
	};
}
