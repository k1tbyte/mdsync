import type { EditorView } from "@codemirror/view";
import { type App, Modal, Platform } from "obsidian";
import { asDrawer } from "@/ui/common";

import { focusHunk } from "./focus";
import { findChangeForLine } from "./helpers";
import { installDismissHandlers } from "./popup-dismiss";
import { positionPopup } from "./popup-placement";
import { buildPopup, type HunkTarget } from "./popup-view";
import type { SignsProvider } from "./provider";
import { changesField, compareTextField } from "./state";

let activePopup: { element: HTMLElement; cleanup: () => void } | null = null;
let activeDrawer: HunkDrawer | null = null;
/** The editor whose change is open, so closing clears its tint. */
let activeView: EditorView | null = null;

export function showHunkPopupAt(
	view: EditorView,
	lineNumber: number,
	event: MouseEvent,
	provider: SignsProvider,
): boolean {
	const baseline = view.state.field(compareTextField, false);
	const data = view.state.field(changesField, false);
	// Changes not yet recomputed after an edit name the lines it moved.
	if (!baseline || data?.doc !== view.state.doc) return false;
	const found = findChangeForLine(data.changes, lineNumber);
	if (!found) return false;

	const target: HunkTarget = {
		view,
		...found,
		baseline,
		provider,
		path: provider.getViewPath(view),
	};
	dismissPopup();
	activeView = view;
	view.dispatch({ effects: focusHunk.of({ open: found.mark }) });
	if (Platform.isPhone) {
		activeDrawer = new HunkDrawer(provider.app, target);
		activeDrawer.open();
		return true;
	}
	const element = buildPopup(target, dismissPopup);
	// The editor's own window: a popout's popup must open and close there.
	view.dom.ownerDocument.body.appendChild(element);
	positionPopup(element, event);
	activePopup = {
		element,
		cleanup: installDismissHandlers(view, element, dismissPopup),
	};
	return true;
}

export function dismissPopupIn(view: EditorView): void {
	if (activeView === view) dismissPopup();
}

export function dismissPopup(): void {
	const view = activeView;
	activeView = null;
	if (view?.dom.isConnected)
		view.dispatch({ effects: focusHunk.of({ open: null }) });
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
		asDrawer(this);
		this.modalEl.addClass("mdsync-hunk-drawer");
		this.contentEl.addClass("mdsync-hunk-drawer-content");
		this.contentEl.empty();
		this.contentEl.appendChild(buildPopup(this.target, dismissPopup));
	}

	onClose(): void {
		// Closed by a swipe or the backdrop: the rest of the popup state goes too.
		if (activeDrawer === this) {
			activeDrawer = null;
			dismissPopup();
		}
		this.contentEl.empty();
	}
}
