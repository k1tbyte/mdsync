import { describe, expect, it } from "vitest";
import {
	buildMergeSession,
	countUnresolved,
	threeWayRegions,
} from "@/features/sync/hunks/merge-model";

describe("threeWayRegions", () => {
	it("gives every region all three ranges; the unchanged side owns the base lines", () => {
		const regions = threeWayRegions(
			["a", "b", "c"],
			["a", "B", "c"],
			["a", "b", "c", "d"],
		);
		expect(regions).toEqual([
			{
				base: [1, 2],
				local: [1, 2],
				remote: [1, 2],
				changed: { local: true, remote: false },
			},
			{
				base: [3, 3],
				local: [3, 3],
				remote: [3, 4],
				changed: { local: false, remote: true },
			},
		]);
	});

	it("merges touching hunks from both sides into one region, like diff3", () => {
		// Local inserts before "b" while remote rewrites "b": adjacent, so one region.
		const regions = threeWayRegions(
			["a", "b", "c"],
			["a", "X", "b", "c"],
			["a", "B", "c"],
		);
		expect(regions).toEqual([
			{
				base: [1, 2],
				local: [1, 3],
				remote: [1, 2],
				changed: { local: true, remote: true },
			},
		]);
	});

	it("keeps a side past the diff budget as one region around its differing middle", () => {
		const base = Array.from({ length: 2000 }, (_, i) => `line ${i}`);
		const local = base.map((line, i) =>
			i === 0 || i === 1999 ? line : `${line} local`,
		);
		expect(threeWayRegions(base, local, base)).toEqual([
			{
				base: [1, 1999],
				local: [1, 1999],
				remote: [1, 1999],
				changed: { local: true, remote: false },
			},
		]);
	});
});

describe("buildMergeSession", () => {
	it("applies one-sided edits up front and marks them applied", () => {
		const base = "one\ntwo\nthree\nfour\nfive\n";
		const local = "one\nTWO\nthree\nfour\nfive\nsix\n";
		const remote = "one\ntwo\nthree\nFOUR\nfive\n";
		const session = buildMergeSession(base, local, remote);
		expect(session.text).toBe("one\nTWO\nthree\nFOUR\nfive\nsix\n");
		expect(session.changes.map((c) => c.conflict)).toEqual([
			false,
			false,
			false,
		]);
		expect(session.changes.map((c) => c.status)).toEqual([
			{ local: "applied", remote: "none" },
			{ local: "none", remote: "applied" },
			{ local: "applied", remote: "none" },
		]);
		const spans = session.changes.map((c) =>
			session.text.slice(c.result.from, c.result.to),
		);
		expect(spans).toEqual(["TWO\n", "FOUR\n", "six\n"]);
	});

	it("keeps the base lines where both sides disagree and leaves both sides open", () => {
		const session = buildMergeSession("a\nb\nc", "a\nL\nc", "a\nR\nc");
		expect(session.text).toBe("a\nb\nc");
		expect(session.changes).toEqual([
			{
				index: 0,
				conflict: true,
				base: [1, 2],
				endsAtEof: false,
				local: [1, 2],
				remote: [1, 2],
				result: { from: 2, to: 4 },
				taken: {},
				status: { local: "open", remote: "open" },
			},
		]);
		expect(countUnresolved(session.changes)).toBe(1);
	});

	it("treats the same edit on both sides as one applied change", () => {
		const session = buildMergeSession("a\nb", "a\nB", "a\nB");
		expect(session.text).toBe("a\nB");
		expect(session.changes[0]?.conflict).toBe(false);
		expect(session.changes[0]?.status).toEqual({
			local: "applied",
			remote: "applied",
		});
	});

	it("puts a conflict appended to a file without final newline at the doc end", () => {
		const session = buildMergeSession("a", "a\nL", "a\nR");
		expect(session.text).toBe("a");
		expect(session.changes[0]?.result).toEqual({ from: 1, to: 1 });
	});

	it("compares on LF so CRLF on one side is not one whole conflict", () => {
		const session = buildMergeSession(
			"a\nb\nc\nd\ne",
			"a\r\nLOCAL\r\nc\r\nd\r\ne",
			"a\nb\nc\nREMOTE\ne",
		);
		expect(session.text).toBe("a\nLOCAL\nc\nREMOTE\ne");
		expect(countUnresolved(session.changes)).toBe(0);
	});
});
