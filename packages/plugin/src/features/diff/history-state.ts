import { DIFF_VIEW_TYPE } from "@/core/constants";
import {
	EDiffDirection,
	type FileDiffModel,
	type HistoryDiffRequest,
	type HistoryVersionRef,
	HUNK_TEXT_MAX_BYTES,
} from "@/features/sync";
import type { DiffHost } from "./host";

export interface HistoryChange {
	before: HistoryVersionRef | null;
	after: HistoryVersionRef | null;
}

export interface DiffViewState {
	path?: string;
	historyHash?: string;
	historyLabel?: string;
	historySize?: number;
	/** Stored version to compare instead of the vault. */
	againstHash?: string;
	againstLabel?: string;
	againstSize?: number;
	historyChange?: HistoryChange;
	historyPreviewIfMissing?: boolean;
	/** Open directly in merge; never stored. */
	merge?: boolean;
}

export interface HistoryDiffTarget extends HistoryVersionRef {
	/** Right side. Without it the version is diffed against the file on disk. */
	against?: { hash: string; label: string; size?: number };
	change?: HistoryChange;
	previewIfMissing?: boolean;
}

/** `merge` goes straight into the conflict's merge, as the diff's Merge… does. */
export async function openDiffView(
	plugin: DiffHost,
	path: string,
	history?: HistoryDiffTarget,
	merge = false,
): Promise<void> {
	const existing = plugin.app.workspace.getLeavesOfType(DIFF_VIEW_TYPE);
	const leaf = existing[0] ?? plugin.app.workspace.getLeaf(true);
	const state: DiffViewState = {
		path,
		historyHash: history?.hash,
		historyLabel: history?.label,
		historySize: history?.size,
		againstHash: history?.against?.hash,
		againstLabel: history?.against?.label,
		againstSize: history?.against?.size,
		historyChange: history?.change,
		historyPreviewIfMissing: history?.previewIfMissing,
		merge: merge || undefined,
	};
	await leaf.setViewState({
		type: DIFF_VIEW_TYPE,
		active: true,
		state: { ...state },
	});
	await plugin.app.workspace.revealLeaf(leaf);
}

/** What a diff tab shows: a file, or stored versions of it. */
export interface DiffTarget {
	path: string | null;
	historyHash: string | null;
	historyLabel: string;
	historySize: number | undefined;
	against: HistoryVersionRef | null;
	historyChange: HistoryChange | null;
	historyPreviewIfMissing: boolean;
}

/** A state without a path keeps `path`; every other field it leaves out resets. */
export function readTarget(
	state: DiffViewState,
	path: string | null,
): DiffTarget {
	return {
		path: state.path ?? path,
		historyHash: state.historyHash ?? null,
		historyLabel: state.historyLabel ?? "Version",
		historySize: state.historySize,
		against: state.againstHash
			? {
					hash: state.againstHash,
					label: state.againstLabel ?? "Other version",
					size: state.againstSize,
				}
			: null,
		historyChange: state.historyChange ?? null,
		historyPreviewIfMissing: state.historyPreviewIfMissing ?? false,
	};
}

export const fileTarget = (path: string | null): DiffTarget =>
	readTarget({}, path);

/** History fields are stored too, so a restored workspace keeps a version diff. */
export function targetState(target: DiffTarget): DiffViewState {
	const { path, historyHash, against } = target;
	return {
		path: path ?? undefined,
		historyHash: historyHash ?? undefined,
		historyLabel: historyHash ? target.historyLabel : undefined,
		historySize: target.historySize,
		againstHash: against?.hash,
		againstLabel: against?.label,
		againstSize: against?.size,
		historyChange: target.historyChange ?? undefined,
		historyPreviewIfMissing: target.historyPreviewIfMissing || undefined,
	};
}

/** A size alone never reloads; a pin rename changes only the label, which the header reads. */
export function sameTarget(a: DiffTarget, b: DiffTarget): boolean {
	return (
		a.path === b.path &&
		a.historyHash === b.historyHash &&
		a.against?.hash === b.against?.hash &&
		(a.historyHash === null || a.historyLabel === b.historyLabel) &&
		!changesDiffer(a.historyChange, b.historyChange) &&
		a.historyPreviewIfMissing === b.historyPreviewIfMissing
	);
}

export type HistoryMode = "change" | "preview" | "diff";

export interface HistoryModeInput
	extends Pick<
		DiffTarget,
		"historyHash" | "historyChange" | "historyPreviewIfMissing" | "against"
	> {
	localExists: boolean;
}

export function selectHistoryMode(input: HistoryModeInput): HistoryMode {
	if (!input.historyHash) return "diff";
	if (input.historyChange) return "change";
	if (input.against) return "diff";
	if (input.historyPreviewIfMissing && !input.localExists) return "preview";
	return "diff";
}

export interface HistoryRequestInput
	extends Omit<DiffTarget, "path" | "historyHash" | "historyPreviewIfMissing"> {
	path: string;
	historyHash: string;
	forceText: boolean;
}

export function buildHistoryRequest(
	input: HistoryRequestInput,
): HistoryDiffRequest {
	const {
		path,
		historyHash,
		historyLabel,
		historySize,
		historyChange,
		against,
		forceText,
	} = input;
	if (historyChange) {
		const { before, after } = historyChange;
		return {
			path,
			left: before
				? { version: before }
				: { absent: true, label: "(did not exist)" },
			right: after ? { version: after } : { absent: true, label: "(deleted)" },
			forceText,
		};
	}
	return {
		path,
		left: {
			version: { hash: historyHash, label: historyLabel, size: historySize },
		},
		right: against ? { version: against } : { current: true },
		forceText,
	};
}

export function changesDiffer(
	a: HistoryChange | null,
	b: HistoryChange | null,
): boolean {
	if (a === b) return false;
	if (!a || !b) return true;
	return (["before", "after"] as const).some(
		(side) =>
			a[side]?.hash !== b[side]?.hash ||
			a[side]?.label !== b[side]?.label ||
			a[side]?.size !== b[side]?.size,
	);
}

export interface HunkHintInput {
	model: FileDiffModel;
	historyChange: HistoryChange | null;
	against: HistoryVersionRef | null;
}

export function compareActionable(input: HunkHintInput): boolean {
	return hunkHintText(input) === null;
}

/** Why per-change actions are off, or null when they are on. */
export function hunkHintText(input: HunkHintInput): string | null {
	const { model, historyChange, against } = input;
	if (
		model.leftSize > HUNK_TEXT_MAX_BYTES ||
		model.rightSize > HUNK_TEXT_MAX_BYTES
	) {
		return "This file is too large for per-change actions; use the whole-file buttons.";
	}
	if (model.movedFrom !== undefined) {
		return `Moved from ${model.movedFrom}. A move syncs whole: push or pull it from the changes list.`;
	}
	if (historyChange !== null) {
		return "Viewing a historical change. Use Restore to bring this version back.";
	}
	if (against !== null) {
		return "Comparing two stored versions. Use Restore to bring the left side back.";
	}
	if (model.direction === EDiffDirection.History && !model.rightPresent) {
		return "This file is not in the vault, so there is nothing to merge into. Restore the whole version instead.";
	}
	return null;
}
