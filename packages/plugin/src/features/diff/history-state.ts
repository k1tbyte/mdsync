import { HUNK_TEXT_MAX_BYTES } from "@/features/sync/constants";
import {
	EDiffDirection,
	type FileDiffModel,
	type HistoryDiffRequest,
	type HistoryVersionRef,
} from "@/features/sync/hunks/projection";

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

export type HistoryMode = "change" | "preview" | "diff";

export interface HistoryModeInput {
	historyHash: string | null;
	historyChange: HistoryChange | null;
	historyPreviewIfMissing: boolean;
	against: HistoryVersionRef | null;
	localExists: boolean;
}

export function selectHistoryMode(input: HistoryModeInput): HistoryMode {
	if (!input.historyHash) return "diff";
	if (input.historyChange) return "change";
	if (input.against) return "diff";
	if (input.historyPreviewIfMissing && !input.localExists) return "preview";
	return "diff";
}

export interface HistoryRequestInput {
	path: string;
	historyHash: string;
	historyLabel: string;
	historySize: number | undefined;
	historyChange: HistoryChange | null;
	against: HistoryVersionRef | null;
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
