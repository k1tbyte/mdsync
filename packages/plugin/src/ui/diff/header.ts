import { EDiffDirection } from "@/sync/projection";
import { appendIconButton } from "@/ui/common/icon-button";

export interface DiffHeaderState {
	path: string;
	direction: EDiffDirection | null;
	isBinary: boolean;
	isEditing: boolean;
	canGoPrevFile: boolean;
	canGoNextFile: boolean;
	showBack: boolean;
	/** Names the side a history restore would take, when that is ambiguous. */
	restoreLabel?: string;
}

export interface DiffHeaderActions {
	saveResolution: () => void;
	cancelResolution: () => void;
	restoreVersion: () => void;
	keepLocal: () => void;
	acceptRemote: () => void;
	/** Keeps the local file and parks the remote version beside it as a copy. */
	keepBothVersions: () => void;
	startMerge: () => void;
	goPrevFile: () => void;
	goNextFile: () => void;
	goBack: () => void;
}

/**
 * Path, file-level actions and file navigation. Change navigation and the
 * layout toggle live in the panel toolbars, next to the changes they move.
 */
export function renderDiffHeader(
	parent: HTMLElement,
	state: DiffHeaderState,
	actions: DiffHeaderActions,
): HTMLElement | null {
	parent.empty();
	let pathParent = parent;
	if (state.showBack) {
		pathParent = parent.createDiv({ cls: "obsync-diff-title" });
		appendIconButton(
			pathParent,
			"arrow-left",
			"Back to source control",
			actions.goBack,
		);
	}
	pathParent.createSpan({ cls: "obsync-diff-path", text: state.path });
	const actionParent = state.showBack
		? parent.createDiv({ cls: "obsync-diff-file-actions" })
		: parent;

	if (state.direction === null) return state.showBack ? actionParent : null;
	if (state.isEditing) {
		appendIconButton(
			actionParent,
			"check",
			"Save and push",
			actions.saveResolution,
		).addClass("mod-cta");
		appendIconButton(
			actionParent,
			"x",
			"Cancel merge",
			actions.cancelResolution,
		);
		return state.showBack ? actionParent : null;
	}

	if (state.direction === EDiffDirection.History) {
		appendButton(
			actionParent,
			state.restoreLabel ?? "Restore this version",
			actions.restoreVersion,
		);
		return state.showBack ? actionParent : null;
	}

	if (state.direction === EDiffDirection.Conflict) {
		appendButton(actionParent, "Keep local", actions.keepLocal);
		appendButton(actionParent, "Accept remote", actions.acceptRemote);
		if (!state.isBinary) {
			appendButton(
				actionParent,
				"Keep both versions",
				actions.keepBothVersions,
			);
			appendButton(actionParent, "Merge…", actions.startMerge);
		}
	}

	appendFileNavigation(actionParent, state, actions);
	return state.showBack ? actionParent : null;
}

function appendFileNavigation(
	parent: HTMLElement,
	state: DiffHeaderState,
	actions: DiffHeaderActions,
): void {
	if (state.canGoPrevFile) {
		appendButton(parent, "◀", actions.goPrevFile, "Previous file");
	}
	if (state.canGoNextFile) {
		appendButton(parent, "▶", actions.goNextFile, "Next file");
	}
}

function appendButton(
	parent: HTMLElement,
	text: string,
	onClick: () => void,
	ariaLabel?: string,
): HTMLButtonElement {
	const button = parent.createEl("button", {
		cls: "obsync-icon-btn",
		text,
	});
	button.type = "button";
	if (ariaLabel) button.setAttr("aria-label", ariaLabel);
	button.addEventListener("click", onClick);
	return button;
}
