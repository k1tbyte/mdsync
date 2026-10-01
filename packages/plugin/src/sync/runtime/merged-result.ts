import { sortedByPath } from "@/shared";
import type { CompareResult } from "@/sync/engine";
import type { Manifest } from "@/sync/types";

/**
 * One UI view of every space's compare. Spaces own disjoint paths, so the union loses nothing; operations
 * read only their own space's.
 */
export function mergeResults(
	results: readonly CompareResult[],
): CompareResult | null {
	const [first, ...rest] = results;
	if (!first || rest.length === 0) return first ?? null;
	const union = <T>(pick: (result: CompareResult) => T[]): T[] =>
		results.flatMap(pick);
	return {
		snapshot: {
			files: sortedByPath(
				Object.assign({}, ...results.map((r) => r.snapshot.files)),
			),
			skipped: union((r) => r.snapshot.skipped),
			emptyFolders: union((r) => r.snapshot.emptyFolders),
			ignoredPaths: union((r) => r.snapshot.ignoredPaths),
			unreadableDirs: union((r) => r.snapshot.unreadableDirs),
		},
		remote: mergeRemotes(results),
		diff: {
			localChanges: union((r) => r.diff.localChanges),
			remoteChanges: union((r) => r.diff.remoteChanges),
			conflicts: union((r) => r.diff.conflicts),
			moves: union((r) => r.diff.moves),
			converged: union((r) => r.diff.converged),
			remoteMoved: results.some((r) => r.diff.remoteMoved),
		},
		// Every space's scan carries the others' entries forward: any one is whole.
		updatedCache: first.updatedCache,
	};
}

/** The first space's head (the vault's) holding every space's files. */
function mergeRemotes(results: readonly CompareResult[]): Manifest | null {
	const head = results.find((r) => r.remote)?.remote;
	if (!head) return null;
	return {
		...head,
		// Each space indexes its own table: a merged one would name the wrong people.
		authors: undefined,
		files: sortedByPath(
			Object.assign({}, ...results.map((r) => r.remote?.files ?? {})),
		),
	};
}
