import { type ArrayChange, diffArrays } from "diff";

import { commonEnds, MAX_EDIT_LENGTH } from "./hunks";

/** A mismatch between two line arrays, as half-open ranges into each. */
export interface LineHunk {
	base: [number, number];
	lines: [number, number];
}

/**
 * For texts whose exact diff ran out of edit budget: one replaced block would make a note-sized conflict, so anchor
 * on lines unique to both texts and run the exact differ only in the gaps. Adapted from No-Instructions/Relay (MIT).
 */
export function anchoredHunks(
	base: readonly string[],
	lines: readonly string[],
): LineHunk[] {
	const { head, tail } = commonEnds(base, lines);
	const baseEnd = base.length - tail;
	const linesEnd = lines.length - tail;
	if (head === baseEnd && head === linesEnd) return [];
	// One side is empty in the middle, so there is nothing to anchor on.
	if (head === baseEnd || head === linesEnd) {
		return [{ base: [head, baseEnd], lines: [head, linesEnd] }];
	}

	const hunks: LineHunk[] = [];
	let baseAt = head;
	let lineAt = head;

	const gap = (baseTo: number, lineTo: number): void => {
		const baseGap = baseTo - baseAt;
		const lineGap = lineTo - lineAt;
		if (baseGap === 0 && lineGap === 0) return;
		if (
			baseGap === lineGap &&
			equalRange(base, baseAt, lines, lineAt, baseGap)
		) {
			return;
		}
		// The same budget bounds the retry: an unaffordable gap stays one coarse hunk.
		const changes = diffArrays(
			base.slice(baseAt, baseTo),
			lines.slice(lineAt, lineTo),
			{ maxEditLength: MAX_EDIT_LENGTH },
		);
		if (changes) hunks.push(...hunksFromChanges(changes, baseAt, lineAt));
		else hunks.push({ base: [baseAt, baseTo], lines: [lineAt, lineTo] });
	};

	for (const [anchorBase, anchorLine] of anchorChain(
		base,
		lines,
		head,
		baseEnd,
		linesEnd,
	)) {
		gap(anchorBase, anchorLine);
		baseAt = anchorBase + 1;
		lineAt = anchorLine + 1;
	}
	gap(baseEnd, linesEnd);

	return hunks;
}

/** Offset by where the diff started; a removal and the insertion right after it are one hunk. */
export function hunksFromChanges(
	changes: readonly ArrayChange<string>[],
	baseFrom = 0,
	lineFrom = 0,
): LineHunk[] {
	const hunks: LineHunk[] = [];
	let baseAt = baseFrom;
	let lineAt = lineFrom;
	for (const change of changes) {
		const baseTo = change.added ? baseAt : baseAt + change.count;
		const lineTo = change.removed ? lineAt : lineAt + change.count;
		if (change.added || change.removed) {
			const last = hunks[hunks.length - 1];
			if (last?.base[1] === baseAt && last.lines[1] === lineAt) {
				last.base = [last.base[0], baseTo];
				last.lines = [last.lines[0], lineTo];
			} else {
				hunks.push({ base: [baseAt, baseTo], lines: [lineAt, lineTo] });
			}
		}
		baseAt = baseTo;
		lineAt = lineTo;
	}
	return hunks;
}

/**
 * Anchors are lines unique to both texts; the longest chain advancing on both sides stops a moved block
 * pulling later anchors backwards.
 */
function anchorChain(
	base: readonly string[],
	lines: readonly string[],
	from: number,
	baseEnd: number,
	linesEnd: number,
): Array<[number, number]> {
	const linePositions = uniquePositions(lines, from, linesEnd);
	const pairs: Array<[number, number]> = [];
	for (const [line, at] of uniquePositions(base, from, baseEnd)) {
		const other = linePositions.get(line);
		if (other !== undefined) pairs.push([at, other]);
	}
	pairs.sort((a, b) => a[0] - b[0]);
	return longestIncreasing(pairs);
}

/** Positions of the lines occurring exactly once in the range. */
function uniquePositions(
	values: readonly string[],
	from: number,
	to: number,
): Map<string, number> {
	const positions = new Map<string, number>();
	for (let i = from; i < to; i++) {
		const value = values[i] as string;
		positions.set(value, positions.has(value) ? -1 : i);
	}
	for (const [value, at] of positions) {
		if (at < 0) positions.delete(value);
	}
	return positions;
}

interface Link {
	pair: [number, number];
	previous: Link | null;
}

/** Patience sort over pairs already ascending in the first coordinate. */
function longestIncreasing(
	pairs: ReadonlyArray<[number, number]>,
): Array<[number, number]> {
	const tails: Link[] = [];
	for (const pair of pairs) {
		let low = 0;
		let high = tails.length;
		while (low < high) {
			const mid = (low + high) >> 1;
			if ((tails[mid] as Link).pair[1] < pair[1]) low = mid + 1;
			else high = mid;
		}
		tails[low] = { pair, previous: low > 0 ? (tails[low - 1] as Link) : null };
	}
	const chain: Array<[number, number]> = [];
	for (let link = tails.at(-1) ?? null; link; link = link.previous) {
		chain.push(link.pair);
	}
	return chain.reverse();
}

function equalRange(
	base: readonly string[],
	baseAt: number,
	lines: readonly string[],
	lineAt: number,
	count: number,
): boolean {
	for (let i = 0; i < count; i++) {
		if (base[baseAt + i] !== lines[lineAt + i]) return false;
	}
	return true;
}
