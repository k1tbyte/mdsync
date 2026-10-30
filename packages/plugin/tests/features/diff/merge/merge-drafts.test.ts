import { describe, expect, it } from "vitest";
import {
	keepMergeDraft,
	type MergeDraft,
	startMerge,
	takeMergeDraft,
} from "@/features/diff/merge/merge-drafts";
import type { MergeChange } from "@/features/sync/hunks/merge-model";

const expected = { localHash: "l1", remoteHash: "r1" };
const draft = (text: string): MergeDraft => ({ text, changes: [], expected });

describe("merge drafts", () => {
	it("gives a kept draft back once, for the same versions", () => {
		keepMergeDraft("a.md", draft("edited"));

		expect(takeMergeDraft("a.md", expected)).toEqual(draft("edited"));
		expect(takeMergeDraft("a.md", expected)).toBeNull();
	});

	it("drops a draft whose local or remote side changed since", () => {
		keepMergeDraft("b.md", draft("edited"));
		expect(takeMergeDraft("b.md", { ...expected, remoteHash: "r2" })).toBe(
			"stale",
		);
		expect(takeMergeDraft("b.md", expected)).toBeNull();

		keepMergeDraft("b.md", draft("edited"));
		expect(takeMergeDraft("b.md", { ...expected, localHash: "l2" })).toBe(
			"stale",
		);
	});

	it("keeps the latest draft of a path and only the five newest paths", () => {
		keepMergeDraft("c.md", draft("first"));
		keepMergeDraft("c.md", draft("second"));
		for (const n of [1, 2, 3, 4, 5]) keepMergeDraft(`n${n}.md`, draft("x"));

		expect(takeMergeDraft("c.md", expected)).toBeNull();
		expect(takeMergeDraft("n1.md", expected)).toEqual(draft("x"));

		keepMergeDraft("d.md", draft("first"));
		keepMergeDraft("e.md", draft("e"));
		keepMergeDraft("d.md", draft("second"));
		expect(takeMergeDraft("d.md", expected)).toEqual(draft("second"));
	});
});

describe("startMerge", () => {
	const conflict = { conflict: true } as MergeChange;
	const session = { text: "fresh", changes: [conflict] };

	it("resumes a kept draft of the same versions and says so", () => {
		keepMergeDraft("s1.md", draft("edited"));

		expect(startMerge("s1.md", expected, session)).toEqual({
			text: "edited",
			changes: [],
			restored: true,
			notice: "Restored your unsaved merge.",
		});
	});

	it("starts fresh over a stale draft and says the edits were dropped", () => {
		keepMergeDraft("s2.md", draft("edited"));

		const start = startMerge(
			"s2.md",
			{ ...expected, localHash: "l2" },
			session,
		);

		expect(start).toMatchObject({ text: "fresh", restored: false });
		expect(start.notice).toMatch(/unsaved edits were dropped/);
	});

	it("says a merge with no conflict merged itself", () => {
		expect(startMerge("s3.md", expected, session).notice).toBeNull();
		expect(
			startMerge("s3.md", expected, { text: "fresh", changes: [] }).notice,
		).toMatch(/auto-merged/);
	});
});
