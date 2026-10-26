import { ButtonComponent, Platform } from "obsidian";
import type {
	EDiffDirection,
	FileDiffModel,
	HistoryVersionRef,
} from "@/sync/projection";
import {
	appendIconButton,
	measureSlide,
	renderPath,
	slideWhenCut,
} from "@/ui/common";
import { renderActionBar } from "./action-bar";
import { type FilePosition, getFilePosition } from "./file-navigation";
import { type HistoryChange, hunkHintText } from "./history-state";

export interface DiffHeaderState {
	path: string;
	direction: EDiffDirection | null;
	isBinary: boolean;
	/** A remote deletion leaves no version to keep beside the local one. */
	remotePresent: boolean;
	isEditing: boolean;
	position: FilePosition | null;
	/** Names the side a history restore would take, when that is ambiguous. */
	restoreLabel?: string;
}

/** Where the open panel puts its own parts of the frame. */
export interface PanelHosts {
	info: HTMLElement;
	controls: HTMLElement;
	pending: HTMLElement;
	/** Save and push, while merging. */
	save: HTMLButtonElement | null;
}

export interface FramePanel {
	mount(hosts: PanelHosts): void;
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

export function renderDiffFrame(
	header: HTMLElement,
	actionBar: HTMLElement,
	state: {
		path: string;
		paths: readonly string[];
		model: FileDiffModel | null;
		isEditing: boolean;
		against: HistoryVersionRef | null;
		historyChange: HistoryChange | null;
		historyLabel: string;
	},
	actions: DiffHeaderActions,
	panel: FramePanel | null,
): void {
	const {
		path,
		paths,
		model,
		isEditing,
		against,
		historyChange,
		historyLabel,
	} = state;
	const frame = {
		path,
		direction: model?.direction ?? null,
		isBinary: model?.isBinary ?? false,
		remotePresent: model?.rightPresent ?? false,
		isEditing,
		position: getFilePosition(paths, path),
		restoreLabel: against ? `Restore ${historyLabel}` : "Restore this version",
	};
	// The panel's controls outlive the re-render; the keyboard stays on them.
	const focused = header.doc.activeElement;
	const hosts = renderDiffHeader(header, frame, actions);
	const hint =
		(panel && model && hunkHintText({ model, historyChange, against })) || "";
	const pending = renderActionBar(actionBar, { ...frame, hint }, actions);
	// A phone keeps them at the thumb, where the conflict's own actions were.
	const save = isEditing
		? renderResolution(Platform.isPhone ? actionBar : header, actions)
		: null;
	panel?.mount({ ...hosts, pending, save });
	if (
		focused instanceof HTMLElement &&
		focused.isConnected &&
		focused !== header.doc.activeElement
	) {
		focused.focus();
	}
}

const STATUS: Record<EDiffDirection, string> = {
	local: "Local change",
	remote: "Incoming change",
	conflict: "Conflict",
	history: "Version",
};

/** A resize, or a tab shown again, changes the room of a sliding title. */
export function refitDiffTitle(root: HTMLElement): void {
	const name = root.querySelector<HTMLElement>(
		".mdsync-diff-path .mdsync-marquee",
	);
	if (name) measureSlide(name);
}

export function renderDiffHeader(
	parent: HTMLElement,
	state: DiffHeaderState,
	actions: DiffHeaderActions,
): Pick<PanelHosts, "info" | "controls"> {
	parent.empty();
	appendIconButton(
		parent,
		"arrow-left",
		"Back to source control",
		actions.goBack,
	);
	const title = parent.createDiv({ cls: "mdsync-diff-title" });
	const path = renderPath(title, state.path);
	path.addClass("mdsync-diff-path");
	const name = path.querySelector<HTMLElement>(".mdsync-file-name");
	if (Platform.isPhone && name) slideWhenCut(name);
	const status = state.direction
		? state.isEditing
			? "Merging"
			: STATUS[state.direction]
		: null;
	if (status) {
		if (Platform.isPhone) {
			path.createSpan({ cls: "mdsync-diff-path-status", text: status });
		} else if (!state.isEditing) {
			// While merging, the panel's own status stands here.
			parent.createSpan({
				cls: `mdsync-diff-status is-${state.direction}`,
				text: status,
			});
		}
	}
	const info = parent.createSpan({ cls: "mdsync-diff-info" });
	parent.createSpan({ cls: "mdsync-diff-spacer" });
	const controls = parent.createDiv({ cls: "mdsync-diff-controls" });
	if (!state.isEditing && state.position) {
		const { index, total } = state.position;
		const nav = parent.createDiv({ cls: "mdsync-diff-file-nav" });
		appendIconButton(
			nav,
			"chevron-left",
			"Previous file",
			actions.goPrevFile,
		).disabled = index === 0;
		nav.createSpan({
			cls: "mdsync-diff-file-position",
			text: `File ${index + 1} of ${total}`,
		});
		appendIconButton(
			nav,
			"chevron-right",
			"Next file",
			actions.goNextFile,
		).disabled = index === total - 1;
	}
	return { info, controls };
}

/** Cancel and Save and push while merging; returns Save. */
function renderResolution(
	parent: HTMLElement,
	actions: DiffHeaderActions,
): HTMLButtonElement {
	const resolution = parent.createDiv({ cls: "mdsync-diff-resolution" });
	new ButtonComponent(resolution)
		.setButtonText("Cancel")
		.onClick(actions.cancelResolution);
	return new ButtonComponent(resolution)
		.setButtonText("Save and push")
		.setCta()
		.onClick(actions.saveResolution).buttonEl;
}
