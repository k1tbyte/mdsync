import { RESOLUTIONS } from "./periods";
import { runsOf, storedRecord } from "./records";
import type { HistoryObject, PushRecord, StoredRecord } from "./types";

/** What storage holds, decoded; `at` is the listing's write time. */
export interface HistoryView {
	pushes: ReadonlyMap<string, { push: PushRecord; at: number }>;
	objects: ReadonlyMap<string, { object: HistoryObject; at: number }>;
}

export interface WalkedRecord {
	record: StoredRecord;
	/** The key it was read from. */
	source: string;
}

export interface Cover {
	/** Newest first, contiguous from HEAD, or from its parent when `lagging`. */
	chain: WalkedRecord[];
	/** HEAD's own record is not there yet. */
	lagging: boolean;
	/** The walk stopped at a missing record, not at the first push. */
	truncated: boolean;
	/** Keys a present object replaces: readers skip them, GC deletes them. */
	consumed: ReadonlySet<string>;
}

export interface Head {
	id: string;
	parentId: string | null;
	vaultId: string;
}

/** The first `length` records of a chain-contiguous run of one key. */
interface Segment {
	key: string;
	/** Index in {@link RESOLUTIONS}. */
	rank: number;
	/** Oldest first. */
	run: readonly StoredRecord[];
	length: number;
	parentId: string | null;
	pushes: number;
}

interface Best {
	segment: Segment | null;
	root: boolean;
	pushes: number;
}

const DEAD_END: Best = { segment: null, root: false, pushes: 0 };

/**
 * Walks back from HEAD through whichever objects reach furthest; among equals the coarser, then the one
 * with more records, then the smaller key. Pushes merge without loss of count, so equal reach means equal coverage.
 */
export function coverOf(view: HistoryView, head: Head | null): Cover {
	const consumed = consumedKeys(view);
	if (!head) return { chain: [], lagging: false, truncated: false, consumed };
	const byLast = new Map<string, Segment[]>();
	for (const segment of segmentsOf(view, head.vaultId, consumed)) {
		const lastId = segment.run[segment.length - 1]?.id;
		if (lastId === undefined) continue;
		byLast.set(lastId, [...(byLast.get(lastId) ?? []), segment]);
	}
	const retired = retiredIds(view, head.vaultId, consumed);
	const lagging = !byLast.has(head.id);
	const start = lagging ? head.parentId : head.id;
	const chain: WalkedRecord[] = [];
	let at = start;
	const memo = solve(start, byLast, retired);
	const seen = new Set<string>();
	while (at !== null && !seen.has(at)) {
		seen.add(at);
		const segment = memo.get(at)?.segment;
		if (!segment) break;
		for (const record of segment.run.slice(0, segment.length).reverse()) {
			chain.push({ record, source: segment.key });
		}
		at = segment.parentId;
	}
	return {
		chain: forwardTimes(chain, view),
		lagging,
		truncated: at !== null && !retired.has(at),
		consumed,
	};
}

/** Where retention ended the chain: the newest record each counts object dropped. */
function retiredIds(
	view: HistoryView,
	vaultId: string,
	consumed: ReadonlySet<string>,
): Set<string> {
	const ids = new Set<string>();
	for (const [key, { object }] of view.objects) {
		if (consumed.has(key) || object.vaultId !== vaultId) continue;
		if (object.lastId !== undefined) ids.add(object.lastId);
	}
	return ids;
}

/**
 * Only a later write replaces an earlier one, so two objects naming each other (a rewrite after a failed
 * delete) cannot both go.
 */
function consumedKeys(view: HistoryView): Set<string> {
	const writtenAt = new Map<string, number>();
	for (const [key, { at }] of view.pushes) writtenAt.set(key, at);
	for (const [key, { at }] of view.objects) writtenAt.set(key, at);
	const consumed = new Set<string>();
	for (const [key, { object, at }] of view.objects) {
		for (const named of object.consumed) {
			const namedAt = writtenAt.get(named);
			if (namedAt === undefined || named === key) continue;
			if (namedAt < at || (namedAt === at && named < key)) consumed.add(named);
		}
	}
	return consumed;
}

function segmentsOf(
	view: HistoryView,
	vaultId: string,
	consumed: ReadonlySet<string>,
): Segment[] {
	const segments: Segment[] = [];
	// Every record ends a segment: a sibling may fork from inside a packed run.
	const add = (key: string, rank: number, run: StoredRecord[]): void => {
		const parentId = run[0]?.parentId ?? null;
		let pushes = 0;
		for (const [index, record] of run.entries()) {
			pushes += record.pushes;
			segments.push({ key, rank, run, length: index + 1, parentId, pushes });
		}
	};
	for (const [key, { push, at }] of view.pushes) {
		if (consumed.has(key) || push.vaultId !== vaultId) continue;
		add(key, 0, [storedRecord(push, at)]);
	}
	for (const [key, { object }] of view.objects) {
		if (consumed.has(key) || object.vaultId !== vaultId) continue;
		// Objects stored by an older walk need not be one run; split rather than trust them.
		for (const run of runsOf(object.records)) {
			add(key, RESOLUTIONS.indexOf(object.res), run);
		}
	}
	return segments;
}

/**
 * Storage clocks straggle: a time never runs back along the chain, so every period is one run of it. A push
 * moved forward is dated anew, its activity with it.
 */
function forwardTimes(
	chain: readonly WalkedRecord[],
	view: HistoryView,
): WalkedRecord[] {
	let floor = Number.NEGATIVE_INFINITY;
	const forward = [...chain].reverse().map((walked) => {
		if (walked.record.at >= floor) {
			floor = walked.record.at;
			return walked;
		}
		const push = view.pushes.get(walked.source)?.push;
		const record = push
			? storedRecord(push, floor)
			: { ...walked.record, at: floor };
		return { ...walked, record };
	});
	return forward.reverse();
}

/** Best choice per id reachable from `start`, iteratively: a long unpacked chain must not overflow the stack. */
function solve(
	start: string | null,
	byLast: ReadonlyMap<string, Segment[]>,
	retired: ReadonlySet<string>,
): Map<string, Best> {
	const memo = new Map<string, Best>();
	if (start === null) return memo;
	const stack = [start];
	const open = new Set<string>();
	while (stack.length > 0) {
		const id = stack.at(-1) as string;
		if (memo.has(id)) {
			stack.pop();
			continue;
		}
		const candidates = byLast.get(id) ?? [];
		if (!open.has(id)) {
			open.add(id);
			for (const { parentId } of candidates) {
				if (parentId !== null && !memo.has(parentId) && !open.has(parentId)) {
					stack.push(parentId);
				}
			}
			continue;
		}
		stack.pop();
		open.delete(id);
		// A parent still open is a cycle in corrupt data: a dead end.
		memo.set(id, pick(candidates, memo, retired));
	}
	return memo;
}

function pick(
	candidates: readonly Segment[],
	memo: Map<string, Best>,
	retired: ReadonlySet<string>,
): Best {
	let best = DEAD_END;
	for (const segment of candidates) {
		const parent = segment.parentId;
		const below = parent === null ? undefined : memo.get(parent);
		const tail =
			parent === null || (!below?.segment && retired.has(parent))
				? { root: true, pushes: 0 }
				: (below ?? DEAD_END);
		const option: Best = {
			segment,
			root: tail.root,
			pushes: segment.pushes + tail.pushes,
		};
		if (better(option, best)) best = option;
	}
	return best;
}

function better(a: Best, b: Best): boolean {
	if (!b.segment) return true;
	if (!a.segment) return false;
	if (a.root !== b.root) return a.root;
	if (a.pushes !== b.pushes) return a.pushes > b.pushes;
	if (a.segment.rank !== b.segment.rank) return a.segment.rank > b.segment.rank;
	if (a.segment.length !== b.segment.length) {
		return a.segment.length > b.segment.length;
	}
	return a.segment.key < b.segment.key;
}
