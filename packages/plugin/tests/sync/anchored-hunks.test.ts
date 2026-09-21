import { diffArrays } from "diff";
import { describe, expect, it } from "vitest";

import { anchoredHunks, type LineHunk } from "@/sync/anchored-hunks";
import { MAX_EDIT_LENGTH } from "@/sync/hunks";
import { threeWayRegions } from "@/sync/merge-model";

/**
 * Rebuilds the right side from the left one and the hunks. It can only match
 * when the stretches between hunks really are equal line for line and their
 * offsets line up - the assumption `threeWayRegions` makes about every hunk
 * list it is given.
 */
function rebuild(
	base: readonly string[],
	lines: readonly string[],
	hunks: readonly LineHunk[],
): string[] {
	const out: string[] = [];
	let at = 0;
	for (const hunk of hunks) {
		out.push(...base.slice(at, hunk.base[0]));
		out.push(...lines.slice(hunk.lines[0], hunk.lines[1]));
		at = hunk.base[1];
	}
	out.push(...base.slice(at));
	return out;
}

/** Large enough that scattered edits exhaust the exact differ's budget. */
function noisyFile(count: number): string[] {
	return Array.from({ length: count }, (_, i) =>
		i % 4 === 0 ? "" : `line ${i} of the note`,
	);
}

function editEvery(lines: readonly string[], step: number): string[] {
	return lines.map((line, i) => (i % step === 0 ? `${line} edited` : line));
}

describe("anchoredHunks", () => {
	it("reports nothing for identical texts", () => {
		expect(anchoredHunks(["a", "b"], ["a", "b"])).toEqual([]);
	});

	it("reports the whole middle when one side has no middle left", () => {
		expect(anchoredHunks(["a", "x", "y", "b"], ["a", "b"])).toEqual([
			{ base: [1, 3], lines: [1, 1] },
		]);
	});

	it("keeps an edit to one line down to that line", () => {
		expect(anchoredHunks(["a", "b", "c"], ["a", "B", "c"])).toEqual([
			{ base: [1, 2], lines: [1, 2] },
		]);
	});

	it("anchors around blocks of duplicate lines", () => {
		const base = ["head", "", "", "", "tail", "keep"];
		const lines = ["head", "", "", "", "tail changed", "keep"];

		expect(rebuild(base, lines, anchoredHunks(base, lines))).toEqual(lines);
	});

	it("does not let a moved block pull later hunks backwards", () => {
		const base = ["a", "one", "two", "b", "three", "c"];
		const lines = ["a", "three", "b", "one", "two", "c"];

		expect(rebuild(base, lines, anchoredHunks(base, lines))).toEqual(lines);
	});

	// Nothing occurs once, so there is no anchor and the gap is the whole file:
	// the retry costs another budgeted diff and must stay bounded by it.
	it("falls back to one block when a repetitive file offers no anchor", () => {
		const base = Array.from({ length: 4000 }, (_, i) => `item ${i % 4}`);
		const lines = base.map((line, i) =>
			i % 5 === 0 ? `${line} edited` : line,
		);

		const started = Date.now();
		const hunks = anchoredHunks(base, lines);

		expect(Date.now() - started).toBeLessThan(2_000);
		expect(rebuild(base, lines, hunks)).toEqual(lines);
	});

	describe("on a file that exhausts the edit budget", () => {
		const base = noisyFile(3000);
		const lines = editEvery(base, 5);

		it("is the path actually under test", () => {
			expect(
				diffArrays(base, lines, { maxEditLength: MAX_EDIT_LENGTH }),
			).toBeUndefined();
		});

		it("splits it into many small hunks instead of one block", () => {
			const hunks = anchoredHunks(base, lines);

			expect(hunks.length).toBeGreaterThan(100);
			for (const hunk of hunks) {
				expect(hunk.base[1] - hunk.base[0]).toBeLessThan(20);
			}
		});

		it("leaves the text between hunks equal on both sides", () => {
			expect(rebuild(base, lines, anchoredHunks(base, lines))).toEqual(lines);
		});

		it("gives the merge many regions rather than one file-sized conflict", () => {
			const remote = editEvery(base, 7);
			const regions = threeWayRegions(base, lines, remote);

			expect(regions.length).toBeGreaterThan(100);
			expect(
				regions.some(
					(region) => region.changed.local && !region.changed.remote,
				),
			).toBe(true);
		});
	});
});
