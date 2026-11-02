import diffSequences from "@jest/diff-sequences";

/** `a[a[0], a[1])` was replaced by `b[b[0], b[1])`; half-open. */
export interface DiffRange {
	a: [number, number];
	b: [number, number];
}

const OVER_BUDGET = new Error("over budget");

/**
 * Myers in linear space, as the ranges between common runs; `null` past `budget` compares. A compare count,
 * unlike a timeout, gives the same answer for the same input every time.
 */
export function diffRanges<T>(
	a: ArrayLike<T>,
	b: ArrayLike<T>,
	budget: number,
): DiffRange[] | null {
	const ranges: DiffRange[] = [];
	let aAt = 0;
	let bAt = 0;
	const gap = (aTo: number, bTo: number): void => {
		if (aTo > aAt || bTo > bAt) ranges.push({ a: [aAt, aTo], b: [bAt, bTo] });
	};
	let compares = 0;
	try {
		diffSequences(
			a.length,
			b.length,
			(i, j) => {
				if (++compares > budget) throw OVER_BUDGET;
				return a[i] === b[j];
			},
			(common, aCommon, bCommon) => {
				gap(aCommon, bCommon);
				aAt = aCommon + common;
				bAt = bCommon + common;
			},
		);
	} catch (error) {
		if (error === OVER_BUDGET) return null;
		throw error;
	}
	gap(a.length, b.length);
	return ranges;
}

/** How many items both arrays share at the start, then at the end of what is left. */
export function commonEnds<T>(
	a: readonly T[],
	b: readonly T[],
): { head: number; tail: number } {
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head++;
	let tail = 0;
	while (
		tail < a.length - head &&
		tail < b.length - head &&
		a[a.length - 1 - tail] === b[b.length - 1 - tail]
	) {
		tail++;
	}
	return { head, tail };
}

/** Everything between the common ends as one replacement: what a diff past its budget falls back to. */
export function changedMiddle<T>(a: readonly T[], b: readonly T[]): DiffRange {
	const { head, tail } = commonEnds(a, b);
	return { a: [head, a.length - tail], b: [head, b.length - tail] };
}
