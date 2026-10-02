import {
	type Conflict,
	type DiffResult,
	EChangeType,
	type FileChange,
	type ManifestEntry,
	type Move,
} from "./types";

type Unpaired = Omit<DiffResult, "moves">;

/** sha256 of no bytes: every empty file has it, so it names none of them. */
const EMPTY_HASH =
	"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

interface Candidate {
	path: string;
	hash: string;
}

/**
 * A path gone on one side and a new one there holding its content is a move, if the pair is unambiguous. The
 * other side's edit of the old path follows the file, so it is no conflict.
 */
export function pairMoves(
	result: Unpaired,
	baseline: Readonly<Record<string, ManifestEntry>>,
): DiffResult {
	const was = (path: string) => baseline[path]?.hash ?? "";
	const conflicts = new Map(result.conflicts.map((c) => [c.path, c]));
	const remote = pairUp(
		[
			...ofType(result.remoteChanges, EChangeType.RemoteDelete),
			...[...conflicts.values()].filter(editedHere),
		].map(({ path }) => ({ path, hash: was(path) })),
		ofType(result.remoteChanges, EChangeType.RemoteAdd).map(
			({ path, remoteHash }) => ({ path, hash: remoteHash ?? "" }),
		),
	);
	const local = pairUp(
		[
			...ofType(result.localChanges, EChangeType.LocalDelete),
			...[...conflicts.values()].filter(editedThere),
		].map(({ path }) => ({ path, hash: was(path) })),
		ofType(result.localChanges, EChangeType.LocalAdd).map(
			({ path, localHash }) => ({ path, hash: localHash ?? "" }),
		),
	);

	const remoteChanges = [...result.remoteChanges];
	const heldBack = new Set<string>();
	for (const [from] of remote) {
		const conflict = conflicts.get(from);
		if (!conflict) continue;
		// Edited here: the rename carries the edit to the new path.
		conflicts.delete(from);
		remoteChanges.push(change(from, EChangeType.RemoteDelete, conflict));
	}
	for (const [from, to] of local) {
		const conflict = conflicts.get(from);
		if (!conflict) continue;
		// Edited there: their text lands in the new path first, then the move pushes.
		conflicts.delete(from);
		heldBack.add(to);
		remoteChanges.push(change(from, EChangeType.RemoteModify, conflict));
	}
	return {
		...result,
		localChanges: result.localChanges.filter((c) => !heldBack.has(c.path)),
		remoteChanges,
		conflicts: [...conflicts.values()],
		moves: [
			...remote.map(([from, to]): Move => ({ from, to, side: "remote" })),
			...local.map(([from, to]): Move => ({ from, to, side: "local" })),
		],
	};
}

/** A move acts whole: asking for one of its paths takes the other too. */
export function withMoves(
	paths: Iterable<string>,
	moves: readonly Move[],
): string[] {
	const taken = new Set(paths);
	for (const { from, to } of moves) {
		if (!taken.has(from) && !taken.has(to)) continue;
		taken.add(from);
		taken.add(to);
	}
	return [...taken];
}

/** Each move under both of its paths. */
export function movesByPath(moves: readonly Move[]): Map<string, Move> {
	return new Map(
		moves.flatMap((move): [string, Move][] => [
			[move.from, move],
			[move.to, move],
		]),
	);
}

/** Changes as the list shows them: a move's two paths are one change. */
export function changeCount(
	changes: readonly FileChange[],
	moves: readonly Move[],
): number {
	if (moves.length === 0) return changes.length;
	const moveOf = movesByPath(moves);
	return new Set(changes.map(({ path }) => moveOf.get(path) ?? path)).size;
}

/** Where a moved file sits here and in the remote. */
export function sidesOf({ from, to, side }: Move): {
	here: string;
	there: string;
} {
	return side === "local"
		? { here: to, there: from }
		: { here: from, there: to };
}

/** One to one by content, else by file name where that is one to one. */
function pairUp(
	gone: readonly Candidate[],
	fresh: readonly Candidate[],
): [string, string][] {
	const targets = groupBy(fresh, ({ hash }) => hash);
	const pairs: [string, string][] = [];
	const add = (from?: Candidate, to?: Candidate) => {
		if (from && to) pairs.push([from.path, to.path]);
	};
	for (const [hash, sources] of groupBy(gone, ({ hash }) => hash)) {
		const into = targets.get(hash);
		if (hash === "" || hash === EMPTY_HASH || !into) continue;
		if (sources.length === 1 && into.length === 1) {
			add(sources[0], into[0]);
			continue;
		}
		const named = groupBy(into, ({ path }) => nameOf(path));
		for (const [name, from] of groupBy(sources, ({ path }) => nameOf(path))) {
			add(single(from), single(named.get(name)));
		}
	}
	return pairs;
}

function single<T>(items: readonly T[] | undefined): T | undefined {
	return items?.length === 1 ? items[0] : undefined;
}

/** Deleted remotely, edited here. */
function editedHere(conflict: Conflict): boolean {
	return (
		conflict.remoteHash === "" &&
		conflict.localHash !== "" &&
		conflict.baselineHash !== null
	);
}

/** Deleted here, edited remotely. */
function editedThere(conflict: Conflict): boolean {
	return (
		conflict.localHash === "" &&
		conflict.remoteHash !== "" &&
		conflict.baselineHash !== null
	);
}

function change(path: string, type: EChangeType, c: Conflict): FileChange {
	return {
		path,
		type,
		localHash: c.localHash || null,
		remoteHash: c.remoteHash || null,
	};
}

function ofType(changes: readonly FileChange[], type: EChangeType) {
	return changes.filter((c) => c.type === type);
}

function groupBy<T>(items: readonly T[], key: (item: T) => string) {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const k = key(item);
		const group = groups.get(k);
		if (group) group.push(item);
		else groups.set(k, [item]);
	}
	return groups;
}

function nameOf(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}
