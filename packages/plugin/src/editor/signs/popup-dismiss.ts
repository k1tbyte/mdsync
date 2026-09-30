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
	document.addEventListener("mousedown", onPointerDown, true);
	document.addEventListener("keydown", onKey, true);
	view.scrollDOM.addEventListener("scroll", dismiss, true);
	return () => {
		document.removeEventListener("mousedown", onPointerDown, true);
		document.removeEventListener("keydown", onKey, true);
		view.scrollDOM.removeEventListener("scroll", dismiss, true);
	};
}
