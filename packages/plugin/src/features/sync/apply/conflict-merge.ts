import type { DataAdapter } from "obsidian";

import { isDrawing, mergeDrawings } from "@/core/drawing";
import { withEolOf } from "@/core/utils";
import { loadLocalText, loadRemoteText } from "../changes/content";
import type { ContentSource } from "../content/load";
import { mergeJsonByKey } from "../hunks/json-merge";
import { buildMergeSession, countUnresolved } from "../hunks/merge-model";
import type { ScopePolicy } from "../scope/scope";
import type { Conflict } from "../types";

/** Base, local, remote to the settled text, or null for a real conflict. */
export type TextMerge = (
	base: string,
	local: string,
	remote: string,
) => string | null;

/**
 * How a conflict merges unattended: notes by line, settings JSON by key. Null for anything else, as a line
 * merge of plugin code or other JSON can be valid by lines and broken as a file; those go to the merge screen.
 */
export function autoMergerFor(
	scope: ScopePolicy,
	path: string,
): TextMerge | null {
	if (scope.isSettingsJson(path)) return mergeJsonByKey;
	return /\.md$/i.test(path) ? mergeNote : null;
}

/**
 * Null, leaving the file untouched, when a side is binary or missing, there is no ancestor, or the conflict
 * is real. The caller writes the result and should gate on `isTextMergeCandidate` to skip needless downloads.
 */
export async function tryAutoMergeConflict(
	deps: ContentSource & { adapter: DataAdapter },
	conflict: Conflict,
	merge: TextMerge,
): Promise<string | null> {
	if (!conflict.baselineHash || !conflict.localHash || !conflict.remoteHash) {
		return null;
	}
	const [baseText, remoteText, localText] = await Promise.all([
		loadRemoteText(deps, conflict.baselineHash),
		loadRemoteText(deps, conflict.remoteHash),
		loadLocalText(deps.adapter, conflict.path),
	]);
	if (baseText === null || remoteText === null || localText === null) {
		return null;
	}
	return merge(baseText, localText, remoteText);
}

function mergeNote(base: string, local: string, remote: string): string | null {
	if ([base, remote, local].some(isDrawing)) {
		return mergeDrawings(base, local, remote);
	}
	// The same regions the merge editor shows, so a file it calls clean opens without conflicts.
	const { text, changes } = buildMergeSession(base, local, remote);
	if (countUnresolved(changes) > 0) return null;
	return withEolOf(local, text);
}
