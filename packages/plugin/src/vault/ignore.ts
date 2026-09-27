import ignore, { type Ignore } from "ignore";
import type { DataAdapter } from "obsidian";

import { IGNORE_FILE_NAME } from "@/constants";
import { isUnder, type Space, spaceOf } from "@/sync/space";

export interface IgnoreMatcher {
	ignores(path: string): boolean;
}

const PASS_THROUGH: IgnoreMatcher = { ignores: () => false };

/** Every space keeps its shared rules in its own root, shared by all who sync it. */
export function ignoreNoteOf(root: string): string {
	return root === "" ? IGNORE_FILE_NAME : `${root}/${IGNORE_FILE_NAME}`;
}

/** The note whose rules govern a path, and the path as those rules read it. */
export function ignoreHome(
	spaces: readonly Space[],
	path: string,
): { note: string; inside: string } {
	const { root } = spaceOf(spaces, path);
	const inside = root === "" ? path : path.slice(root.length + 1);
	return { note: ignoreNoteOf(root), inside };
}

export function isIgnoreNote(spaces: readonly Space[], path: string): boolean {
	return ignoreHome(spaces, path).note === path;
}

export async function loadSharedIgnoreMatcher(
	adapter: DataAdapter,
	root = "",
): Promise<IgnoreMatcher> {
	// A missing note ignores nothing.
	const text = await adapter.read(ignoreNoteOf(root)).catch(() => "");
	return createIgnoreMatcher(text, root);
}

/** Sync build for callers that already hold the pattern text; rules read paths inside `root`. */
export function createIgnoreMatcher(
	patternsText: string,
	root = "",
): IgnoreMatcher {
	const out: string[] = [];
	for (const raw of patternsText.split(/\r?\n/)) {
		const trimmed = raw.trim();
		if (trimmed && !trimmed.startsWith("#")) out.push(trimmed);
	}

	if (out.length === 0) return PASS_THROUGH;
	const matcher: Ignore = ignore();
	matcher.add(out);
	return {
		ignores(path) {
			const normalized = path.replace(/^\/+/, "");
			if (!isUnder(normalized, root)) return false;
			const inside =
				root === "" ? normalized : normalized.slice(root.length + 1);
			if (!inside) return false;
			return matcher.ignores(inside);
		},
	};
}
