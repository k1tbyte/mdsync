import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { foldedBands } from "@/features/diff/lines/gap-widgets";
import type { LineRange } from "@/features/sync/hunks/hunks";

const docOf = (lines: number) =>
	Text.of(Array.from({ length: lines }, (_, index) => `line ${index + 1}`));

describe("foldedBands", () => {
	// One change: line 11 on the left became lines 11-12 on the right.
	const left = { doc: docOf(30), changes: [[10, 11]] as LineRange[] };
	const right = { doc: docOf(31), changes: [[10, 12]] as LineRange[] };

	it("pairs the runs past three context lines in both panes", () => {
		expect(foldedBands(left, right, new Set())).toEqual([
			{
				near: { from: 0, to: left.doc.line(7).to },
				far: { from: 0, to: right.doc.line(7).to },
			},
			{
				near: { from: left.doc.line(15).from, to: left.doc.length },
				far: { from: right.doc.line(16).from, to: right.doc.length },
			},
		]);
	});

	it("leaves opened runs out", () => {
		expect(foldedBands(left, right, new Set([0]))).toHaveLength(1);
	});

	it("keeps runs shorter than three lines", () => {
		const near = { doc: docOf(8), changes: [[4, 5]] as LineRange[] };
		expect(foldedBands(near, near, new Set())).toEqual([]);
	});
});
