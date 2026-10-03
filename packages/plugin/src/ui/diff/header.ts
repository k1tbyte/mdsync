import { EDiffDirection } from "@/sync/projection";
import { appendIconButton } from "@/ui/common";
import { renderPath } from "@/ui/source-control/row-parts";

export interface DiffHeaderState {
	path: string;
	direction: EDiffDirection | null;
	isBinary: boolean;
	/** A remote deletion leaves no version to keep beside the local one. */
	remotePresent: boolean;
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

/** Path, file-level actions and file navigation; change navigation and the layout toggle live in the panel toolbars. */
export function renderDiffHeader(
	parent: HTMLElement,
	state: DiffHeaderState,
	actions: DiffHeaderActions,
): HTMLElement | null {
	parent.empty();
	let pathParent = parent;
	if (state.showBack) {
		pathParent = parent.createDiv({ cls: "mdsync-diff-title" });
		appendIconButton(
			pathParent,
			"arrow-left",
			"Back to source control",
			actions.goBack,
		);
	}
	renderPath(pathParent, state.path).addClass("mdsync-diff-path");
	const actionParent = state.showBack
		? parent.createDiv({ cls: "mdsync-diff-file-actions" })
		: parent;
	const trailing = state.showBack ? pathParent : actionParent;

	if (state.direction === null) return state.showBack ? actionParent : null;
	if (state.isEditing) {
		appendIconButton(
			trailing,
			"check",
			"Save and push",
			actions.saveResolution,
		).addClass("mod-cta");
		appendIconButton(trailing, "x", "Cancel merge", actions.cancelResolution);
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
			if (state.remotePresent) {
				appendButton(
					actionParent,
					"Keep both versions",
					actions.keepBothVersions,
				);
			}
			appendButton(actionParent, "Merge…", actions.startMerge);
		}
	}

	appendFileNavigation(trailing, state, actions);
	return state.showBack ? actionParent : null;
}

function appendFileNavigation(
	parent: HTMLElement,
	state: DiffHeaderState,
	actions: DiffHeaderActions,
): void {
	if (state.canGoPrevFile) {
		appendIconButton(
			parent,
			"chevron-left",
			"Previous file",
			actions.goPrevFile,
		);
	}
	if (state.canGoNextFile) {
		appendIconButton(parent, "chevron-right", "Next file", actions.goNextFile);
	}
}

function appendButton(
	parent: HTMLElement,
	text: string,
	onClick: () => void,
): HTMLButtonElement {
	const button = parent.createEl("button", { text });
	button.type = "button";
	button.addEventListener("click", onClick);
	return button;
}
