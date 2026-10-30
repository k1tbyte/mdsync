import type { MergeChange } from "@/features/sync";

export interface MergeDraft {
	text: string;
	changes: readonly MergeChange[];
	expected: { localHash: string; remoteHash: string };
}

/** Each holds a whole file: only the latest few stay. */
const MAX_DRAFTS = 5;

// Plugin lifetime: a draft outlives its closed tab, not a reload.
const drafts = new Map<string, MergeDraft>();

export function keepMergeDraft(path: string, draft: MergeDraft): void {
	drafts.delete(path);
	drafts.set(path, draft);
	for (const oldest of drafts.keys()) {
		if (drafts.size <= MAX_DRAFTS) break;
		drafts.delete(oldest);
	}
}

export interface MergeStart {
	text: string;
	changes: readonly MergeChange[];
	/** From a draft: its edits count before any undo step exists. */
	restored: boolean;
	notice: string | null;
}

/** A kept draft of these versions, else the fresh session; the notice says which. */
export function startMerge(
	path: string,
	expected: MergeDraft["expected"],
	session: { text: string; changes: readonly MergeChange[] },
): MergeStart {
	const draft = takeMergeDraft(path, expected);
	if (draft && draft !== "stale") {
		const { text, changes } = draft;
		return {
			text,
			changes,
			restored: true,
			notice: "Restored your unsaved merge.",
		};
	}
	const notice =
		draft === "stale"
			? "This file changed since you left its merge, so your unsaved edits were dropped."
			: session.changes.some((change) => change.conflict)
				? null
				: "No overlapping changes - auto-merged. Review and save.";
	return {
		text: session.text,
		changes: session.changes,
		restored: false,
		notice,
	};
}

/** Takes the draft for `path` off the store; `stale` when either side changed since it was kept. */
export function takeMergeDraft(
	path: string,
	expected: MergeDraft["expected"],
): MergeDraft | "stale" | null {
	const draft = drafts.get(path);
	if (!draft) return null;
	drafts.delete(path);
	const same =
		draft.expected.localHash === expected.localHash &&
		draft.expected.remoteHash === expected.remoteHash;
	return same ? draft : "stale";
}
