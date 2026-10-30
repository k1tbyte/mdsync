import { canonical, isRecord, type Json, ordered } from "./json-align";

/** A key one side does not have: absent is not `null`. */
const ABSENT = Symbol("absent");
const CLASH = Symbol("clash");
type Slot = Json | typeof ABSENT;

/**
 * Settings JSON merged three-way by key: a key changed on one side takes that side, equal edits converge, and
 * two different edits of one key clash. Arrays and scalars are whole values. Written in local's key order, indent
 * and ending. Null on a clash, or when a side is not exactly `JSON.stringify` output: rewriting it could change it.
 */
export function mergeJsonByKey(
	base: string,
	local: string,
	remote: string,
): string | null {
	const [baseSide, localSide, remoteSide] = [base, local, remote].map(
		canonical,
	);
	if (!baseSide || !localSide || !remoteSide) return null;
	const merged = mergeValue(baseSide.value, localSide.value, remoteSide.value);
	if (merged === CLASH || merged === ABSENT) return null;
	return (
		JSON.stringify(ordered(merged, localSide.value), null, localSide.indent) +
		localSide.tail
	);
}

function mergeValue(
	base: Slot,
	local: Slot,
	remote: Slot,
): Slot | typeof CLASH {
	if (same(local, remote) || same(base, remote)) return local;
	if (same(base, local)) return remote;
	if (!isRecord(base) || !isRecord(local) || !isRecord(remote)) return CLASH;
	// Null prototype: a "__proto__" key stays a key.
	const out: Record<string, Json> = Object.create(null);
	for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
		const value = mergeValue(
			slot(base, key),
			slot(local, key),
			slot(remote, key),
		);
		if (value === CLASH) return CLASH;
		if (value !== ABSENT) out[key] = value;
	}
	return out;
}

function slot(record: Record<string, Json>, key: string): Slot {
	return Object.hasOwn(record, key) ? record[key] : ABSENT;
}

/** Deep equality in which key order does not count. */
function same(a: Slot, b: Slot): boolean {
	if (a === b) return true;
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((item, i) => same(item, b[i]));
	}
	if (!isRecord(a) || !isRecord(b)) return false;
	const keys = Object.keys(a);
	return (
		keys.length === Object.keys(b).length &&
		keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]))
	);
}
