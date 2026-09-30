import { describe, expect, it } from "vitest";
import { type DiffInput, diff } from "@/sync/diff";
import {
	EChangeType,
	EFileKind,
	type LocalSnapshot,
	type Manifest,
	type ManifestEntry,
} from "@/sync/types";

function mockManifest(
	snapshotId: string,
	files: Record<string, Partial<ManifestEntry>> = {},
): Manifest {
	const filledFiles: Record<string, ManifestEntry> = {};
	for (const [k, v] of Object.entries(files)) {
		filledFiles[k] = {
			hash: "",
			size: 0,
			mtime: 0,
			kind: EFileKind.Vault,
			...v,
		};
	}
	return {
		version: 1,
		vaultId: "vault",
		snapshotId,
		parentSnapshotId: null,
		createdAt: 0,
		deviceId: "dev",
		files: filledFiles,
	};
}

function mockLocal(
	files: Record<string, Partial<ManifestEntry>> = {},
): LocalSnapshot {
	const filledFiles: Record<string, ManifestEntry> = {};
	for (const [k, v] of Object.entries(files)) {
		filledFiles[k] = {
			hash: "",
			size: 0,
			mtime: 0,
			kind: EFileKind.Vault,
			...v,
		};
	}
	return {
		files: filledFiles,
		skipped: [],
		emptyFolders: [],
		ignoredPaths: [],
		unreadableDirs: [],
	};
}

describe("diff", () => {
	it("identifies local insertions", () => {
		const input: DiffInput = {
			baseline: mockManifest("v1"),
			remote: mockManifest("v1"),
			local: mockLocal({ "new.md": { hash: "hash1" } }),
		};
		const result = diff(input);
		expect(result.localChanges).toHaveLength(1);
		expect(result.localChanges[0]).toMatchObject({
			path: "new.md",
			type: EChangeType.LocalAdd,
			localHash: "hash1",
			remoteHash: null,
		});
		expect(result.remoteChanges).toHaveLength(0);
		expect(result.conflicts).toHaveLength(0);
	});

	it("identifies remote insertions", () => {
		const input: DiffInput = {
			baseline: mockManifest("v1"),
			remote: mockManifest("v2", { "new.md": { hash: "hash1" } }),
			local: mockLocal(),
		};
		const result = diff(input);
		expect(result.remoteChanges).toHaveLength(1);
		expect(result.remoteChanges[0]).toMatchObject({
			path: "new.md",
			type: EChangeType.RemoteAdd,
			localHash: null,
			remoteHash: "hash1",
		});
		expect(result.localChanges).toHaveLength(0);
		expect(result.conflicts).toHaveLength(0);
	});

	it("identifies conflicts on concurrent modification to different hashes", () => {
		const input: DiffInput = {
			baseline: mockManifest("v1", { "shared.md": { hash: "base" } }),
			remote: mockManifest("v2", { "shared.md": { hash: "remote-hash" } }),
			local: mockLocal({ "shared.md": { hash: "local-hash" } }),
		};
		const result = diff(input);
		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0]).toMatchObject({
			path: "shared.md",
			localHash: "local-hash",
			remoteHash: "remote-hash",
			baselineHash: "base",
		});
		expect(result.localChanges).toHaveLength(0);
		expect(result.remoteChanges).toHaveLength(0);
	});

	it("ignores concurrent modification to the identical hash", () => {
		const input: DiffInput = {
			baseline: mockManifest("v1", { "shared.md": { hash: "base" } }),
			remote: mockManifest("v2", { "shared.md": { hash: "same-hash" } }),
			local: mockLocal({ "shared.md": { hash: "same-hash" } }),
		};
		const result = diff(input);
		expect(result.conflicts).toHaveLength(0);
		expect(result.localChanges).toHaveLength(0);
		expect(result.remoteChanges).toHaveLength(0);
	});

	it("detects when remote was moved (snapshot change)", () => {
		const input: DiffInput = {
			baseline: mockManifest("v1"),
			remote: mockManifest("v2"),
			local: mockLocal(),
		};
		const result = diff(input);
		expect(result.remoteMoved).toBe(true);
	});

	it("leaves out-of-scope remote and baseline paths alone", () => {
		const input: DiffInput = {
			baseline: mockManifest("v1", { "hidden/a.md": { hash: "base" } }),
			remote: mockManifest("v2", {
				"hidden/a.md": { hash: "remote" },
				"open/b.md": { hash: "remote" },
			}),
			local: mockLocal(),
			includes: (path) => !path.startsWith("hidden/"),
		};
		const result = diff(input);
		expect(result.remoteChanges.map((change) => change.path)).toEqual([
			"open/b.md",
		]);
		// Unfiltered it reads as a conflict: absent locally, moved on both sides.
		expect(result.conflicts).toHaveLength(0);
		expect(result.localChanges).toHaveLength(0);
	});

	it("keeps a local path the scan already admitted", () => {
		const input: DiffInput = {
			baseline: null,
			remote: mockManifest("v2"),
			local: mockLocal({ "note.md": { hash: "local" } }),
			includes: () => false,
		};
		expect(diff(input).localChanges.map((change) => change.path)).toEqual([
			"note.md",
		]);
	});

	it("takes saves of one drawing scene for the same content", () => {
		const input: DiffInput = {
			baseline: mockManifest("v1", { "d.md": { hash: "b", scene: "s1" } }),
			remote: mockManifest("v2", { "d.md": { hash: "r", scene: "s2" } }),
			local: mockLocal({ "d.md": { hash: "l", scene: "s2" } }),
		};
		expect(diff(input).converged).toEqual(["d.md"]);

		const viewOnly: DiffInput = {
			baseline: mockManifest("v1", { "d.md": { hash: "b", scene: "s1" } }),
			remote: mockManifest("v1", { "d.md": { hash: "b", scene: "s1" } }),
			local: mockLocal({ "d.md": { hash: "l", scene: "s1" } }),
		};
		const quiet = diff(viewOnly);
		expect([quiet.localChanges, quiet.remoteChanges, quiet.converged]).toEqual([
			[],
			[],
			[],
		]);
	});
});

describe("moves", () => {
	const at = (hashes: Record<string, string>) =>
		Object.fromEntries(
			Object.entries(hashes).map(([path, hash]) => [path, { hash }]),
		);
	const run = (
		local: Record<string, string>,
		remote: Record<string, string>,
		baseline: Record<string, string>,
	) =>
		diff({
			local: mockLocal(at(local)),
			remote: mockManifest("r", at(remote)),
			baseline: mockManifest("b", at(baseline)),
		});

	it("pairs a file renamed here, keeping both halves as changes", () => {
		const result = run({ "b.md": "h" }, { "a.md": "h" }, { "a.md": "h" });
		expect(result.moves).toEqual([{ from: "a.md", to: "b.md", side: "local" }]);
		expect(result.localChanges.map((c) => [c.path, c.type])).toEqual([
			["b.md", EChangeType.LocalAdd],
			["a.md", EChangeType.LocalDelete],
		]);
	});

	it("pairs a file renamed remotely", () => {
		const result = run({ "a.md": "h" }, { "b.md": "h" }, { "a.md": "h" });
		expect(result.moves).toEqual([
			{ from: "a.md", to: "b.md", side: "remote" },
		]);
		expect(result.conflicts).toEqual([]);
	});

	it("lets an edit here follow a remote rename instead of a conflict", () => {
		const result = run({ "a.md": "mine" }, { "b.md": "h" }, { "a.md": "h" });
		expect(result.conflicts).toEqual([]);
		expect(result.moves).toEqual([
			{ from: "a.md", to: "b.md", side: "remote" },
		]);
		expect(result.remoteChanges.map((c) => [c.path, c.type])).toEqual([
			["b.md", EChangeType.RemoteAdd],
			["a.md", EChangeType.RemoteDelete],
		]);
		expect(result.localChanges).toEqual([]);
	});

	it("holds a rename here back while the old path's remote edit comes in", () => {
		const result = run({ "b.md": "h" }, { "a.md": "theirs" }, { "a.md": "h" });
		expect(result.conflicts).toEqual([]);
		expect(result.moves).toEqual([{ from: "a.md", to: "b.md", side: "local" }]);
		expect(result.remoteChanges.map((c) => [c.path, c.type])).toEqual([
			["a.md", EChangeType.RemoteModify],
		]);
		expect(result.localChanges).toEqual([]);
	});

	it("pairs same content by file name, and leaves what it cannot tell apart", () => {
		const moved = run(
			{ "New/x.md": "e", "New/y.md": "e" },
			{ "Old/x.md": "e", "Old/y.md": "e" },
			{ "Old/x.md": "e", "Old/y.md": "e" },
		);
		expect(moved.moves).toEqual([
			{ from: "Old/x.md", to: "New/x.md", side: "local" },
			{ from: "Old/y.md", to: "New/y.md", side: "local" },
		]);
		const unclear = run(
			{ "p.md": "e", "q.md": "e" },
			{ "x.md": "e", "y.md": "e" },
			{ "x.md": "e", "y.md": "e" },
		);
		expect(unclear.moves).toEqual([]);
	});

	it("never pairs empty files: they share one hash", () => {
		const empty =
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
		expect(
			run({ "b.md": empty }, { "a.md": empty }, { "a.md": empty }).moves,
		).toEqual([]);
	});

	it("is no move when the other side changed the new path or the old one is gone there too", () => {
		expect(
			run({ "b.md": "h" }, { "b.md": "other" }, { "a.md": "h" }).moves,
		).toEqual([]);
		expect(run({ "b.md": "h" }, {}, { "a.md": "h" }).moves).toEqual([]);
	});
});
