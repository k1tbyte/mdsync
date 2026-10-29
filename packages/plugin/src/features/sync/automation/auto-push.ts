import type { Space } from "../remote/space";
import { type DiffResult, EChangeType } from "../types";

export interface AutoPushSelection {
	paths: string[];
	/** Local deletions past the limit: all of them wait for the person. */
	held: string[];
}

/**
 * Paths a background push may take. Any conflict blocks the whole push; `only` narrows the set; more
 * deletions than `deleteLimit` (null: no limit) are all held back, a move is no deletion.
 */
export function selectAutoPushPaths(
	diff: DiffResult,
	only?: ReadonlySet<string>,
	deleteLimit: number | null = null,
): AutoPushSelection {
	if (diff.conflicts.length > 0) return { paths: [], held: [] };
	const changes = diff.localChanges.filter(
		(change) => !only || covers(only, change.path),
	);
	const moved = new Set(
		diff.moves.filter((move) => move.side === "local").map(({ from }) => from),
	);
	const deleted = changes
		.filter(
			({ path, type }) => type === EChangeType.LocalDelete && !moved.has(path),
		)
		.map(({ path }) => path);
	const held =
		deleteLimit !== null && deleted.length > deleteLimit ? deleted : [];
	const holds = new Set(held);
	return {
		paths: changes.map(({ path }) => path).filter((path) => !holds.has(path)),
		held,
	};
}

export type AutoPushSelector = (
	space: Space,
	diff: DiffResult,
	only?: ReadonlySet<string>,
) => string[];

/**
 * Held deletions go to `report` once per set, not on every cycle that holds the same ones. `editing`: a slow
 * file still being edited, left for a later push.
 */
export function createAutoPushSelector(
	deleteLimit: () => number | null,
	report: (space: Space, held: readonly string[]) => void,
	editing: (path: string) => boolean,
): AutoPushSelector {
	const reported = new Map<string, string>();
	return (space, diff, only) => {
		const { paths, held } = selectAutoPushPaths(diff, only, deleteLimit());
		const key = held.join("\n");
		if (held.length === 0) {
			// A narrowed selection says nothing of the deletions it left out.
			if (!only) reported.delete(space.id);
		} else if (reported.get(space.id) !== key) {
			reported.set(space.id, key);
			report(space, held);
		}
		const waiting = new Set(paths.filter(editing));
		// A push takes both ends of a move, so a held end holds the other.
		for (const { from, to, side } of diff.moves) {
			if (side === "local" && (editing(from) || editing(to))) {
				waiting.add(from);
				waiting.add(to);
			}
		}
		return paths.filter((path) => !waiting.has(path));
	};
}

/** A folder's event stands for the files in it: a folder rename names only the folder. */
function covers(paths: ReadonlySet<string>, path: string): boolean {
	if (paths.has(path)) return true;
	const slash = path.lastIndexOf("/");
	return slash > 0 && covers(paths, path.slice(0, slash));
}
