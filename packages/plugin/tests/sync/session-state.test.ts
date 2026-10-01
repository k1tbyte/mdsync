import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS_SYNC } from "@/settings/model";
import type { CompareResult, EngineDependencies } from "@/sync/engine";
import {
	carryHashes,
	mergeSessionIntoLocal,
	projectSession,
	recomputeAfterWrite,
	sharesHold,
} from "@/sync/session-state";
import { VAULT_SPACE } from "@/sync/space";
import type {
	LocalState,
	Manifest,
	ManifestEntry,
	SessionState,
} from "@/sync/types";
import { EFileKind } from "@/sync/types";
import { createScopePolicy } from "@/vault/scope";

const TEAM = { id: "team", root: "Team" };

const scope: EngineDependencies["scope"] = createScopePolicy({
	settingsSync: DEFAULT_SETTINGS_SYNC,
	configDir: ".obsidian",
});

function entry(hash: string): ManifestEntry {
	return { hash, size: hash.length, mtime: 1000, kind: EFileKind.Vault };
}

function manifest(files: Record<string, string>): Manifest {
	return {
		version: 1,
		vaultId: "vault",
		snapshotId: `s-${Object.values(files).join("")}`,
		parentSnapshotId: null,
		createdAt: 0,
		deviceId: "device-a",
		files: Object.fromEntries(
			Object.entries(files).map(([path, hash]) => [path, entry(hash)]),
		),
	};
}

function compareResult(local: Record<string, string>): CompareResult {
	return {
		snapshot: {
			files: manifest(local).files,
			skipped: [],
			emptyFolders: [],
			ignoredPaths: [],
			unreadableDirs: [],
		},
		remote: null,
		diff: {
			localChanges: [],
			remoteChanges: [],
			conflicts: [],
			moves: [],
			converged: [],
			remoteMoved: false,
		},
		updatedCache: {},
	};
}

function session(baseline: Manifest | null): SessionState {
	return {
		deviceId: "device-a",
		deviceName: "device-a",
		vaultId: "vault",
		baseline,
		hashCache: {},
	};
}

describe("recomputeAfterWrite", () => {
	it("believes what the operation says it wrote, not the baseline", async () => {
		const prev = compareResult({ "note.md": "local" });
		const merged = entry("merged");

		const result = recomputeAfterWrite(
			prev,
			// Auto-merge advances the baseline to the remote version first.
			session(manifest({ "note.md": "remote" })),
			{
				newRemote: manifest({ "note.md": "remote" }),
				touchedPaths: new Set(["note.md"]),
				localEntries: new Map([["note.md", merged]]),
			},
			scope,
		);

		expect(result.snapshot.files["note.md"]).toEqual(merged);
		// Merged text equals neither side, so it is still ours to push.
		expect(result.diff.localChanges.map((c) => c.path)).toEqual(["note.md"]);
	});

	it("drops the path when the operation reports it as gone", async () => {
		const prev = compareResult({ "note.md": "local" });

		const result = recomputeAfterWrite(
			prev,
			session(manifest({ "note.md": "base" })),
			{
				newRemote: manifest({}),
				touchedPaths: new Set(["note.md"]),
				localEntries: new Map([["note.md", null]]),
			},
			scope,
		);

		expect(result.snapshot.files["note.md"]).toBeUndefined();
	});

	it("falls back to the baseline for a path the operation only published", async () => {
		const prev = compareResult({ "note.md": "local" });

		const result = recomputeAfterWrite(
			prev,
			session(manifest({ "note.md": "published" })),
			{
				newRemote: manifest({ "note.md": "published" }),
				touchedPaths: new Set(["note.md"]),
			},
			scope,
		);

		expect(result.snapshot.files["note.md"]?.hash).toBe("published");
		expect(result.diff.localChanges).toHaveLength(0);
	});

	it("leaves untouched paths exactly as the previous snapshot had them", async () => {
		const prev = compareResult({ "a.md": "aa", "b.md": "bb" });

		const result = recomputeAfterWrite(
			prev,
			session(manifest({ "a.md": "aa", "b.md": "bb" })),
			{
				newRemote: manifest({ "a.md": "aa", "b.md": "bb" }),
				touchedPaths: new Set(["a.md"]),
				localEntries: new Map([["a.md", entry("aa")]]),
			},
			scope,
		);

		expect(result.snapshot.files["b.md"]).toEqual(prev.snapshot.files["b.md"]);
	});
});

describe("session projection", () => {
	const local: LocalState = {
		deviceId: "device-a",
		deviceName: "Laptop",
		storages: {
			"s3:one": { vaultId: "v1", baseline: manifest({ "a.md": "aa" }) },
			"s3:two": { vaultId: "v2", baseline: null },
		},
		hashCache: { "a.md": { mtime: 1, size: 2, hash: "aa" } },
	};

	it("reads only the slot belonging to the active storage", () => {
		expect(projectSession(local, "s3:two", "")?.vaultId).toBe("v2");
		expect(projectSession(local, "s3:two", "")?.baseline).toBeNull();
		expect(projectSession(local, "unknown", "")?.vaultId).toBeNull();
	});

	it("keeps a device rename made while the operation ran", () => {
		const session = projectSession(local, "s3:one", "");
		const renamed = { ...local, deviceName: "Desk" };

		const next = mergeSessionIntoLocal(renamed, session, "s3:one", VAULT_SPACE);

		expect(next.deviceName).toBe("Desk");
	});

	it("writes back one slot without disturbing the others", () => {
		const next = mergeSessionIntoLocal(
			local,
			{
				deviceId: "device-a",
				deviceName: "Laptop",
				vaultId: "v2",
				baseline: manifest({ "b.md": "bb" }),
				hashCache: local.hashCache,
			},
			"s3:two",
			VAULT_SPACE,
		);

		expect(next.storages["s3:one"]).toEqual(local.storages["s3:one"]);
		expect(next.storages["s3:two"]?.baseline?.files["b.md"]?.hash).toBe("bb");
	});

	it("keeps a share's baseline when its folder moves, at the new root", () => {
		const session = projectSession(local, "s3:one", "");
		const team = mergeSessionIntoLocal(
			local,
			{ ...session, baseline: manifest({ "Team/a.md": "aa" }) },
			"s3:one",
			TEAM,
		);
		expect(team.storages["s3:one"]).toMatchObject({
			root: "Team",
			space: "team",
		});
		// Unmoved: the stored baseline itself, so the persister can still debounce.
		const same = projectSession(team, "s3:one", "Team");
		expect(same.baseline).toBe(team.storages["s3:one"]?.baseline);

		const moved = projectSession(team, "s3:one", "Projects/Team");
		expect(Object.keys(moved.baseline?.files ?? {})).toEqual([
			"Projects/Team/a.md",
		]);
		const next = mergeSessionIntoLocal(team, moved, "s3:one", {
			...TEAM,
			root: "Projects/Team",
		});
		expect(next.storages["s3:one"]?.root).toBe("Projects/Team");
	});

	it("keeps a slot's share bases through writes that do not name them, not past a new vault", () => {
		const bases = { "Team/a.md": entry("aa") };
		const held = mergeSessionIntoLocal(
			local,
			projectSession(local, "s3:one", ""),
			"s3:one",
			VAULT_SPACE,
			bases,
		);
		const session = projectSession(held, "s3:one", "");

		const pushed = mergeSessionIntoLocal(held, session, "s3:one", VAULT_SPACE);
		expect(pushed.storages["s3:one"]?.shareBases).toEqual(bases);

		const adopted = mergeSessionIntoLocal(
			held,
			{ ...session, vaultId: "v9" },
			"s3:one",
			VAULT_SPACE,
		);
		expect(adopted.storages["s3:one"]?.shareBases).toBeUndefined();

		const pruned = mergeSessionIntoLocal(
			held,
			session,
			"s3:one",
			VAULT_SPACE,
			{},
		);
		expect(pruned.storages["s3:one"]).not.toHaveProperty("shareBases");
	});

	it("says whether the share owning a path holds it, wherever it was mounted", () => {
		const state: LocalState = {
			...local,
			storages: {
				...local.storages,
				"broker|team": {
					vaultId: "t",
					baseline: manifest({ "Old/a.md": "aa" }),
					root: "Old",
					space: "team",
				},
			},
		};
		const holds = sharesHold(state, [VAULT_SPACE, TEAM]);

		expect(holds("Team/a.md")).toBe(true);
		expect(holds("Team/b.md")).toBe(false);
		expect(holds("a.md")).toBe(false);
	});

	it("forgets the slot when the session no longer has a vault", () => {
		const next = mergeSessionIntoLocal(
			local,
			{
				deviceId: "device-a",
				vaultId: null,
				baseline: null,
				hashCache: {},
			},
			"s3:one",
			VAULT_SPACE,
		);
		expect(next.storages["s3:one"]).toBeUndefined();
		expect(next.storages["s3:two"]).toBeDefined();
	});
});

describe("carryHashes", () => {
	const entry = (hash: string) => ({ mtime: 1, size: 1, hash });
	const state = {
		deviceId: "d",
		storages: {},
		hashCache: {
			"a.md": entry("a"),
			"Team/b.md": entry("b"),
			"Team/c/d.md": entry("d"),
			"Teams/e.md": entry("e"),
		},
	};

	it("moves a renamed file's hash to its new path", () => {
		expect(carryHashes(state, "a.md", "x.md", false).hashCache).toEqual({
			"x.md": entry("a"),
			"Team/b.md": entry("b"),
			"Team/c/d.md": entry("d"),
			"Teams/e.md": entry("e"),
		});
	});

	it("moves every hash under a renamed folder, and only those", () => {
		expect(carryHashes(state, "Team", "Old/Team", true).hashCache).toEqual({
			"a.md": entry("a"),
			"Old/Team/b.md": entry("b"),
			"Old/Team/c/d.md": entry("d"),
			"Teams/e.md": entry("e"),
		});
	});

	it("keeps the state itself when nothing it knows moved", () => {
		expect(carryHashes(state, "new.md", "newer.md", false)).toBe(state);
	});
});
