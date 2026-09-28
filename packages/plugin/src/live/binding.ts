import {
	Compartment,
	type Extension,
	Prec,
	StateEffect,
} from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";
import type { MarkdownView } from "obsidian";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";

import { authorMarks } from "./author-marks";
import { USERS } from "./authors";
import type { BoundEditor } from "./model";
import { scrollMarks } from "./scroll-marks";
import type { LiveSession } from "./session";
import type { TextModel } from "./text-model";

/**
 * Attaches a session to one leaf. `registerEditorExtension` reaches every
 * editor, so the binding goes in per leaf through a Compartment and leaves the
 * same way. Obsidian exposes CodeMirror only as the undocumented `editor.cm`.
 * A file switch replaces the whole EditorState, so the binding is gone before
 * the next file's text arrives and never carries it into this room.
 */
export function bindEditor(
	view: MarkdownView,
	session: LiveSession<TextModel>,
	me: string | null,
): BoundEditor {
	const cm = (view.editor as unknown as { cm?: EditorView }).cm;
	if (!cm) return { showAuthors() {}, detach() {} };

	// Keystrokes typed while the room was answering go in before the editor follows it.
	session.adopt(view.editor.getValue());
	const text = session.model.text.toString();
	// Skipping the no-op keeps the cursor where the user left it.
	if (view.editor.getValue() !== text) view.editor.setValue(text);

	const compartment = new Compartment();
	const marks = new Compartment();
	const tint = (who: string | null): Extension =>
		who === null
			? []
			: authorMarks(session.model.text, session.doc.getMap(USERS), who);
	cm.dispatch({
		effects: StateEffect.appendConfig.of(
			compartment.of([
				yCollab(session.model.text, session.awareness, {
					undoManager: session.model.undoManager,
				}),
				// Obsidian's own undo would also revert what other devices typed.
				Prec.high(keymap.of(yUndoManagerKeymap)),
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

	return {
		showAuthors: (who) => apply(marks.reconfigure(tint(who))),
		detach: () => apply(compartment.reconfigure([])),
	};
}
