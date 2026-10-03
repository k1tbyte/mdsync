import type { EditorView } from "@codemirror/view";
import { type App, Modal, Platform } from "obsidian";

import { findChunkForLine, findSyncChangeForLine } from "./helpers";
import { installDismissHandlers } from "./popup-dismiss";
import { positionPopup } from "./popup-placement";
import { buildPopup, type HunkTarget } from "./popup-view";
import type { SignsProvider } from "./provider";
import { chunksField, compareTextField } from "./state";

let activePopup: { element: HTMLElement; cleanup: () => void } | null = null;
let activeDrawer: HunkDrawer | null = null;

export function showHunkPopupAt(
	view: EditorView,
	lineNumber: number,
	event: MouseEvent,
	provider: SignsProvider,
): boolean {
	const baseline = view.state.field(compareTextField, false);
	const data = view.state.field(chunksField, false);
	if (!baseline || !data || data.chunks.length === 0) return false;
	const chunk = findChunkForLine(data.chunks, view.state.doc, lineNumber);
	if (!chunk) return false;

	const path = provider.getViewPath(view);
	const target: HunkTarget = {
		view,
		chunk,
		baseline,
		provider,
		path,
		syncChange:
			path === null
				? null
				: findSyncChangeForLine(lineNumber, baseline, view.state.doc),
	};
	dismissPopup();
	if (Platform.isPhone) {
		activeDrawer = new HunkDrawer(provider.app, target);
		activeDrawer.open();
		return true;
	}
	const element = buildPopup(target, dismissPopup);
	document.body.appendChild(element);
	positionPopup(element, event);
	activePopup = {
		element,
		cleanup: installDismissHandlers(view, element, dismissPopup),
	};
	return true;
}

export function dismissPopup(): void {
	const drawer = activeDrawer;
	activeDrawer = null;
	drawer?.close();
	activePopup?.cleanup();
	activePopup?.element.remove();
	activePopup = null;
}

class HunkDrawer extends Modal {
	constructor(
		app: App,
		private readonly target: HunkTarget,
	) {
		super(app);
	}

	onOpen(): void {
		this.containerEl.addClass("mdsync-hunk-drawer-container");
		this.modalEl.addClass("mdsync-hunk-drawer");
		this.contentEl.addClass("mdsync-hunk-drawer-content");
		this.contentEl.empty();
		this.contentEl.appendChild(buildPopup(this.target, dismissPopup));
	}

	onClose(): void {
		if (activeDrawer === this) activeDrawer = null;
		this.contentEl.empty();
	}
}
