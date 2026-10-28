import type { DataAdapter } from "obsidian";

import { isDrawing, mergeDrawings } from "@/core/drawing";
import { withEolOf } from "@/core/utils";
import { loadLocalText, loadRemoteText } from "../changes/content";
import type { ContentSource } from "../content/load";
import { buildMergeSession, countUnresolved } from "../hunks/merge-model";
import type { Conflict } from "../types";

/**
 * Null, leaving the file untouched, when a side is binary or missing, there is no ancestor, or the conflict
 * is real. The caller writes the result and should gate on `isTextMergeCandidate` to skip needless downloads.
 */
export async function tryAutoMergeConflict(
	deps: ContentSource & { adapter: DataAdapter },
	conflict: Conflict,
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
	if ([baseText, remoteText, localText].some(isDrawing)) {
		return mergeDrawings(baseText, localText, remoteText);
	}
	// The same regions the merge editor shows, so a file it calls clean opens without conflicts.
	const { text, changes } = buildMergeSession(baseText, localText, remoteText);
	if (countUnresolved(changes) > 0) return null;
	return withEolOf(localText, text);
}
