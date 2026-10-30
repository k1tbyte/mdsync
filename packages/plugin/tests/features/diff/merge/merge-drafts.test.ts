import { describe, expect, it } from "vitest";
import {
	keepMergeDraft,
	type MergeDraft,
	takeMergeDraft,
} from "@/features/diff/merge/merge-drafts";

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
