import { describe, expect, it, vi } from "vitest";

import {
	createAutoPushSelector,
	selectAutoPushPaths,
} from "@/features/sync/automation/auto-push";
import { VAULT_SPACE } from "@/features/sync/remote/space";
import type { Conflict, DiffResult, FileChange } from "@/features/sync/types";

function change(path: string): FileChange {
	return { path, type: "local-modify", localHash: "a", remoteHash: "b" };
}

function deleted(path: string): FileChange {
	return { path, type: "local-delete", localHash: null, remoteHash: "b" };
}

function added(path: string): FileChange {
	return { path, type: "local-add", localHash: "b", remoteHash: null };
}

function conflict(path: string): Conflict {
	return { path, localHash: "a", remoteHash: "b", baselineHash: null };
}

function diff(partial: Partial<DiffResult>): DiffResult {
	return {
		localChanges: [],
		remoteChanges: [],
		conflicts: [],
		moves: [],
		converged: [],
		remoteMoved: false,
		...partial,
	};
}

const paths = (d: DiffResult, only?: ReadonlySet<string>, limit?: number) =>
	selectAutoPushPaths(d, only, limit).paths;

describe("selectAutoPushPaths", () => {
	it("takes every local change when nothing blocks it", () => {
		const d = diff({ localChanges: [change("a.md"), change("b.md")] });
		expect(paths(d)).toEqual(["a.md", "b.md"]);
	});

	it("holds the whole push back while any conflict is open", () => {
		const d = diff({
			localChanges: [change("a.md")],
			conflicts: [conflict("b.md")],
		});
		expect(paths(d)).toEqual([]);
	});

	it("limits the push to the requested paths", () => {
		const d = diff({ localChanges: [change("a.md"), change("b.md")] });
		expect(paths(d, new Set(["b.md"]))).toEqual(["b.md"]);
	});

	it("takes the files in a requested folder", () => {
		const d = diff({ localChanges: [change("New/a.md"), change("Newer.md")] });
		expect(paths(d, new Set(["New"]))).toEqual(["New/a.md"]);
	});

	it("returns nothing when the diff is empty", () => {
		expect(paths(diff({}))).toEqual([]);
	});

	it("holds every deletion past the limit and pushes the rest", () => {
		const d = diff({
			localChanges: [deleted("F/a.md"), deleted("F/b.md"), change("c.md")],
		});
		expect(selectAutoPushPaths(d, undefined, 1)).toEqual({
			paths: ["c.md"],
			held: ["F/a.md", "F/b.md"],
		});
	});

	it("pushes deletions up to the limit, and any number without one", () => {
		const d = diff({ localChanges: [deleted("a.md"), deleted("b.md")] });
		expect(selectAutoPushPaths(d, undefined, 2).held).toEqual([]);
		expect(selectAutoPushPaths(d).held).toEqual([]);
	});

	it("counts only deletions in the requested paths", () => {
		const d = diff({ localChanges: [deleted("a.md"), deleted("b.md")] });
		expect(selectAutoPushPaths(d, new Set(["a.md"]), 1)).toEqual({
			paths: ["a.md"],
			held: [],
		});
	});

	it("never counts a move as a deletion", () => {
		const d = diff({
			localChanges: [deleted("old.md"), added("new.md")],
			moves: [{ from: "old.md", to: "new.md", side: "local" }],
		});
		expect(selectAutoPushPaths(d, undefined, 0)).toEqual({
			paths: ["old.md", "new.md"],
			held: [],
		});
	});
});

describe("createAutoPushSelector", () => {
	const two = diff({ localChanges: [deleted("a.md"), deleted("b.md")] });

	it("reports a held set once, however many cycles hold it", () => {
		const report = vi.fn();
		const select = createAutoPushSelector(
			() => 1,
			report,
			() => false,
		);
		expect(select(VAULT_SPACE, two)).toEqual([]);
		select(VAULT_SPACE, two);
		expect(report).toHaveBeenCalledOnce();
		expect(report).toHaveBeenCalledWith(VAULT_SPACE, ["a.md", "b.md"]);
	});

	it("reports the set again once a full selection held nothing", () => {
		const report = vi.fn();
		let limit: number | null = 1;
		const select = createAutoPushSelector(
			() => limit,
			report,
			() => false,
		);
		select(VAULT_SPACE, two);
		select(VAULT_SPACE, two, new Set(["c.md"]));
		select(VAULT_SPACE, two);
		expect(report).toHaveBeenCalledOnce();
		limit = null;
		select(VAULT_SPACE, two);
		limit = 1;
		select(VAULT_SPACE, two);
		expect(report).toHaveBeenCalledTimes(2);
	});

	it("leaves out a slow file still being edited", () => {
		const select = createAutoPushSelector(
			() => null,
			vi.fn(),
			(path) => path === "a.md",
		);
		expect(select(VAULT_SPACE, two)).toEqual(["b.md"]);
	});
});
