import { RESOLUTIONS } from "./periods";
import { storedRecord } from "./records";
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

interface Segment {
	key: string;
	/** Index in {@link RESOLUTIONS}. */
	rank: number;
	/** Oldest first. */
	records: StoredRecord[];
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
		const lastId = segment.records.at(-1)?.id;
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
		for (const record of [...segment.records].reverse()) {
			chain.push({ record, source: segment.key });
		}
		at = segment.parentId;
	}
	return {
		chain,
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
	for (const [key, { push, at }] of view.pushes) {
		if (consumed.has(key) || push.vaultId !== vaultId) continue;
		segments.push({
			key,
			rank: 0,
			records: [storedRecord(push, at)],
			parentId: push.parentId,
			pushes: 1,
		});
	}
	for (const [key, { object }] of view.objects) {
		const [first] = object.records;
		if (consumed.has(key) || object.vaultId !== vaultId || !first) continue;
		segments.push({
			key,
			rank: RESOLUTIONS.indexOf(object.res),
			records: object.records,
			parentId: first.parentId,
			pushes: object.records.reduce((sum, record) => sum + record.pushes, 0),
		});
	}
	return segments;
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
	if (a.segment.records.length !== b.segment.records.length) {
		return a.segment.records.length > b.segment.records.length;
	}
	return a.segment.key < b.segment.key;
}
