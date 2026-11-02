import { describe, expect, it } from "vitest";
import { RestoredFiles } from "@/features/sync/automation/restored-files";
import type { CompareResult } from "@/features/sync/engine";
import { type Space, VAULT_SPACE } from "@/features/sync/remote/space";
import type { DiffResult, FileChange, LocalStore } from "@/features/sync/types";

function changes(...localChanges: FileChange[]): DiffResult {
	return {
		localChanges,
		remoteChanges: [],
		conflicts: [],
		moves: [],
		converged: [],
		remoteMoved: false,
	};
}

const modified = (path: string, localHash: string): FileChange => ({
	path,
	type: "local-modify",
	localHash,
	remoteHash: "r",
});

const deleted = (path: string): FileChange => ({
	path,
	type: "local-delete",
	localHash: null,
	remoteHash: "r",
});

/** A compare that read `files` (path to hash), found `changed` and could not read `skipped`. */
function compared(
	files: Record<string, string>,
	changed: FileChange[],
	skipped: string[] = [],
): CompareResult {
	return {
		snapshot: {
			files: Object.fromEntries(
				Object.entries(files).map(([path, hash]) => [
					path,
					{ hash, size: 1, mtime: 1, kind: "vault" },
				]),
			),
			skipped: skipped.map((path) => ({ path, reason: "unreadable" })),
			emptyFolders: [],
			ignoredPaths: [],
			unreadableDirs: [],
		},
		remote: null,
		diff: changes(...changed),
		updatedCache: {},
	};
}

function memory(): LocalStore & { value: unknown } {
	const store = {
		value: null as unknown,
		load: () => store.value,
		save: (value: unknown) => {
			store.value = value;
		},
	};
	return store;
}

const SHARE: Space = { id: "s", root: "Shared" };

describe("RestoredFiles", () => {
	it("holds what a restore wrote or removed while the diff still shows it", () => {
		const restored = new RestoredFiles(memory());
		restored.hold(
			VAULT_SPACE,
			new Map([
				["a.md", "h1"],
				["b.md", null],
			]),
		);
		const diff = changes(modified("a.md", "h1"), deleted("b.md"));

		expect(restored.waiting(VAULT_SPACE, diff)).toEqual(
			new Set(["a.md", "b.md"]),
		);
		expect(restored.waiting(SHARE, diff)).toEqual(new Set());
	});

	it("lets go once the file is edited, or published or pulled by any operation", () => {
		const restored = new RestoredFiles(memory());
		restored.hold(
			VAULT_SPACE,
			new Map([
				["a.md", "h1"],
				["b.md", "h2"],
			]),
		);

		restored.settle(
			VAULT_SPACE,
			compared({ "a.md": "edited", "b.md": "h2" }, [
				modified("a.md", "edited"),
			]),
		);

		expect(
			restored.waiting(
				VAULT_SPACE,
				changes(modified("a.md", "h1"), modified("b.md", "h2")),
			),
		).toEqual(new Set());
	});

	it("lets go of a file scanned with no change: pushed by hand or pulled", () => {
		const restored = new RestoredFiles(memory());
		restored.hold(VAULT_SPACE, new Map([["a.md", "h1"]]));

		restored.settle(VAULT_SPACE, compared({ "a.md": "h1" }, []));

		expect(
			restored.waiting(VAULT_SPACE, changes(modified("a.md", "h1"))),
		).toEqual(new Set());
	});

	it.each([
		["could not read", compared({}, [], ["a.md"])],
		["left out, ignored or under another spelling", compared({}, [])],
		[
			"found in conflict",
			{
				...compared({ "a.md": "h1" }, []),
				diff: {
					...changes(),
					conflicts: [
						{
							path: "a.md",
							localHash: "h1",
							remoteHash: "r",
							baselineHash: "b",
						},
					],
				},
			},
		],
	])("keeps the hold of a file the compare %s", (_, result) => {
		const restored = new RestoredFiles(memory());
		restored.hold(VAULT_SPACE, new Map([["a.md", "h1"]]));

		restored.settle(VAULT_SPACE, result);

		expect(
			restored.waiting(VAULT_SPACE, changes(modified("a.md", "h1"))),
		).toEqual(new Set(["a.md"]));
	});

	it("follows a shared folder whose root moved", () => {
		const restored = new RestoredFiles(memory());
		restored.hold(SHARE, new Map([["Shared/a.md", "h1"]]));
		const moved = { ...SHARE, root: "Renamed" };

		restored.settle(
			moved,
			compared({ "Renamed/a.md": "h1" }, [modified("Renamed/a.md", "h1")]),
		);

		expect(
			restored.waiting(moved, changes(modified("Renamed/a.md", "h1"))),
		).toEqual(new Set(["Renamed/a.md"]));
	});

	it("keeps an earlier restore held when a later one never wrote", () => {
		const restored = new RestoredFiles(memory());
		restored.hold(VAULT_SPACE, new Map([["a.md", "h1"]]));
		restored.hold(VAULT_SPACE, new Map([["a.md", "h2"]]));

		restored.settle(
			VAULT_SPACE,
			compared({ "a.md": "h1" }, [modified("a.md", "h1")]),
		);

		expect(
			restored.waiting(VAULT_SPACE, changes(modified("a.md", "h1"))),
		).toEqual(new Set(["a.md"]));
		expect(
			restored.waiting(VAULT_SPACE, changes(modified("a.md", "h2"))),
		).toEqual(new Set());
	});

	it("keeps its holds across a restart", () => {
		const store = memory();
		new RestoredFiles(store).hold(VAULT_SPACE, new Map([["a.md", "h1"]]));

		expect(
			new RestoredFiles(store).waiting(
				VAULT_SPACE,
				changes(modified("a.md", "h1")),
			),
		).toEqual(new Set(["a.md"]));
	});
});
