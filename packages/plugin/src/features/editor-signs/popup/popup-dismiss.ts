import type { EditorView } from "@codemirror/view";

export function installDismissHandlers(
	view: EditorView,
	popup: HTMLElement,
	dismiss: () => void,
): () => void {
	const onPointerDown = (event: MouseEvent) => {
		if (!popup.contains(event.target as Node)) dismiss();
	};
	const onKey = (event: KeyboardEvent) => {
		if (event.key === "Escape") dismiss();
	};
	const doc = view.dom.ownerDocument;
	doc.addEventListener("mousedown", onPointerDown, true);
	doc.addEventListener("keydown", onKey, true);
	view.scrollDOM.addEventListener("scroll", dismiss, true);
	return () => {
		doc.removeEventListener("mousedown", onPointerDown, true);
		doc.removeEventListener("keydown", onKey, true);
		view.scrollDOM.removeEventListener("scroll", dismiss, true);
	};
}
