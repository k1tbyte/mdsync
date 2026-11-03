import type { EditorView } from "@codemirror/view";
import type { MarkdownView } from "obsidian";

import { frameTask } from "@/core/ui";
import type { LiveSession } from "@/features/live";
import { watchCursor } from "@/features/live";

/** Their cursor moves freely inside the middle half of the view; past it, it is centred again. */
const MARGIN = 0.25;

/** Keeps `key`'s cursor in view; returns the stop. Scrolls only, never moves the caret. */
export function trackCursor(
	markdown: MarkdownView,
	session: LiveSession,
	key: string,
): () => void {
	const { editor } = markdown;
	const cursor = watchCursor(session, key);
	const show = (): void => {
		const at = cursor.at();
		if (at === null || isCalm(markdown, at)) return;
		const pos = editor.offsetToPos(at);
		editor.scrollIntoView({ from: pos, to: pos }, true);
	};
	// Out of the event: y-codemirror changes awareness inside an editor update, where a scroll throws.
	const frame = frameTask(show);
	const unwatch = cursor.watch(() => frame.schedule());
	frame.schedule();
	return () => {
		unwatch();
		frame.cancel();
	};
}

function isCalm(markdown: MarkdownView, at: number): boolean {
	const cm = (markdown.editor as unknown as { cm?: EditorView }).cm;
	const coords = cm?.coordsAtPos(at);
	if (!cm || !coords) return false;
	const view = cm.scrollDOM.getBoundingClientRect();
	const margin = view.height * MARGIN;
	return (
		coords.top >= view.top + margin && coords.bottom <= view.bottom - margin
	);
}
