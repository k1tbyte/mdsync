import { Compartment, Prec, StateEffect } from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";
import type { MarkdownView } from "obsidian";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";

import type { LiveSession } from "./session";

/**
 * Attaches a session to one leaf. `registerEditorExtension` reaches every
 * editor, so the binding goes in per leaf through a Compartment and leaves the
 * same way. Obsidian exposes CodeMirror only as the undocumented `editor.cm`.
 * A file switch replaces the whole EditorState, so the binding is gone before
 * the next file's text arrives and never carries it into this room.
 */
export function bindEditor(
	view: MarkdownView,
	session: LiveSession,
): () => void {
	const cm = (view.editor as unknown as { cm?: EditorView }).cm;
	if (!cm) return () => {};

	// Keystrokes typed while the room was answering go in before the editor follows it.
	session.adopt(view.editor.getValue());
	const text = session.text.toString();
	// Skipping the no-op keeps the cursor where the user left it.
	if (view.editor.getValue() !== text) view.editor.setValue(text);

	const compartment = new Compartment();
	cm.dispatch({
		effects: StateEffect.appendConfig.of(
			compartment.of([
				yCollab(session.text, session.awareness, {
					undoManager: session.undoManager,
				}),
				// Obsidian's own undo would also revert what other devices typed.
				Prec.high(keymap.of(yUndoManagerKeymap)),
			]),
		),
	});

	return () => {
		try {
			cm.dispatch({ effects: compartment.reconfigure([]) });
		} catch {
			// The leaf was torn down before its binding.
		}
	};
}
