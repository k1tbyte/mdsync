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
