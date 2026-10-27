import { commonEnds, type DiffRange, diffRanges } from "@/core/utils";

import { DIFF_BUDGET } from "./hunks";

/**
 * For texts whose exact diff ran out of budget: one replaced block would make a note-sized conflict, so anchor
 * on lines unique to both texts and run the exact differ only in the gaps. Adapted from No-Instructions/Relay (MIT).
 */
export function anchoredHunks(
	base: readonly string[],
	lines: readonly string[],
): DiffRange[] {
	const { head, tail } = commonEnds(base, lines);
	const baseEnd = base.length - tail;
	const linesEnd = lines.length - tail;
	if (head === baseEnd && head === linesEnd) return [];
	// One side is empty in the middle, so there is nothing to anchor on.
	if (head === baseEnd || head === linesEnd) {
		return [{ a: [head, baseEnd], b: [head, linesEnd] }];
	}

	const hunks: DiffRange[] = [];
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
		const ranges = diffRanges(
			base.slice(baseAt, baseTo),
			lines.slice(lineAt, lineTo),
			DIFF_BUDGET,
		);
		if (!ranges) {
			hunks.push({ a: [baseAt, baseTo], b: [lineAt, lineTo] });
			return;
		}
		for (const { a, b } of ranges) {
			hunks.push({
				a: [a[0] + baseAt, a[1] + baseAt],
				b: [b[0] + lineAt, b[1] + lineAt],
			});
		}
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
