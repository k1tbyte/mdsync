import type { DiffResult } from "./types";

/** Paths a background push may take. Any conflict blocks the whole push; `only` narrows the set. */
export function selectAutoPushPaths(
	diff: DiffResult,
	only?: ReadonlySet<string>,
): string[] {
	if (diff.conflicts.length > 0) return [];
	return diff.localChanges
		.filter((change) => !only || covers(only, change.path))
		.map((change) => change.path);
}

/** A folder's event stands for the files in it: a folder rename names only the folder. */
function covers(paths: ReadonlySet<string>, path: string): boolean {
	if (paths.has(path)) return true;
	const slash = path.lastIndexOf("/");
	return slash > 0 && covers(paths, path.slice(0, slash));
}
