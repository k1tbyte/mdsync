import { TestSession, useEncryptionKey } from "@tests/helpers/session";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS_SYNC } from "@/settings/model";
import { advanceSessionAfterPush } from "@/sync/baseline";
import { compare, pushPaths } from "@/sync/engine";
import {
	forgetDroppedForeign,
	heldShareBases,
	ownedFiles,
} from "@/sync/foreign";
import { readHistoryLog } from "@/sync/history/store";
import { objectKey } from "@/sync/manifest";
import { EFileKind, type Manifest, type ManifestEntry } from "@/sync/types";
import { createScopePolicy } from "@/vault/scope";

const vaultScope = createScopePolicy({
	settingsSync: DEFAULT_SETTINGS_SYNC,
	configDir: ".obsidian",
	otherRoots: ["Shared/p"],
});
const plainScope = createScopePolicy({
	settingsSync: DEFAULT_SETTINGS_SYNC,
	configDir: ".obsidian",
});

function entry(hash: string): ManifestEntry {
	return { hash, size: 1, mtime: 1, kind: EFileKind.Vault };
}

function manifest(files: Record<string, ManifestEntry>): Manifest {
	return {
		version: 1,
		vaultId: "v",
		snapshotId: "s1",
		parentSnapshotId: null,
		createdAt: 1,
		deviceId: "d",
		files,
	};
}

describe("ownedFiles", () => {
	it("drops the paths another space owns", () => {
		const files = { "a.md": entry("a"), "Shared/p/b.md": entry("b") };
		expect(Object.keys(ownedFiles(files, vaultScope))).toEqual(["a.md"]);
	});

	it("hands back the same object when nothing is foreign", () => {
		const files = { "a.md": entry("a"), "Shared/q.md": entry("q") };
		expect(ownedFiles(files, vaultScope)).toBe(files);
		expect(ownedFiles(files, plainScope)).toBe(files);
	});

	it("keeps a share's own paths and drops the vault's", () => {
		const share = createScopePolicy({
			settingsSync: DEFAULT_SETTINGS_SYNC,
			configDir: ".obsidian",
			root: "Shared/p",
		});
		const files = { "a.md": entry("a"), "Shared/p/b.md": entry("b") };
		expect(Object.keys(ownedFiles(files, share))).toEqual(["Shared/p/b.md"]);
	});
});

describe("forgetDroppedForeign", () => {
	const baseline = manifest({
		"a.md": entry("a"),
		"Shared/p/b.md": entry("b"),
		"Shared/p/c.md": entry("c"),
	});

	it("forgets frozen entries the remote no longer has", () => {
		const remote = manifest({
			"a.md": entry("a"),
			"Shared/p/c.md": entry("c"),
		});
		const next = forgetDroppedForeign(baseline, remote, vaultScope);
		expect(Object.keys(next?.files ?? {})).toEqual(["a.md", "Shared/p/c.md"]);
	});

	it("never forgets an owned path, even one the remote deleted", () => {
		const next = forgetDroppedForeign(
			baseline,
			manifest({ "Shared/p/b.md": entry("b"), "Shared/p/c.md": entry("c") }),
			vaultScope,
		);
		expect(Object.keys(next?.files ?? {})).toContain("a.md");
	});

	it("keeps the baseline object while the remote still holds every entry", () => {
		const remote = manifest({ ...baseline.files });
		expect(forgetDroppedForeign(baseline, remote, vaultScope)).toBe(baseline);
		expect(forgetDroppedForeign(null, remote, vaultScope)).toBeNull();
	});
});

describe("heldShareBases", () => {
	const baseline = manifest({
		"a.md": entry("a"),
		"Shared/p/b.md": entry("b"),
		"Shared/p/c.md": entry("c"),
	});
	const remote = manifest({ "a.md": entry("a") });
	const holdsNone = () => false;

	it("keeps what the baseline forgets while the share holds none of it", () => {
		expect(
			heldShareBases(undefined, baseline, remote, vaultScope, holdsNone),
		).toEqual({ "Shared/p/b.md": entry("b"), "Shared/p/c.md": entry("c") });
	});

	it("lets a path go once the share holds it", () => {
		const kept = heldShareBases(
			undefined,
			baseline,
			remote,
			vaultScope,
			holdsNone,
		);
		const next = heldShareBases(
			kept,
			null,
			remote,
			vaultScope,
			(path) => path === "Shared/p/b.md",
		);
		expect(Object.keys(next)).toEqual(["Shared/p/c.md"]);
	});

	it("lets every path go once the folder is the vault's again", () => {
		const kept = { "Shared/p/b.md": entry("b") };
		expect(heldShareBases(kept, null, remote, plainScope, holdsNone)).toEqual(
			{},
		);
	});

	it("keeps nothing the remote still lists", () => {
		const listed = manifest({ ...baseline.files });
		expect(
			heldShareBases(undefined, baseline, listed, vaultScope, holdsNone),
		).toEqual({});
	});
});

describe("publishing from a space with another space's folder in it", () => {
	useEncryptionKey();

	async function vaultWithFrozenCopy() {
		const session = new TestSession();
		session.adapter.putText("a.md", "A");
		session.adapter.putText("Shared/p/b.md", "B");
		const first = await session.compare();
		const manifest = await pushPaths(session.deps(), first, [
			"a.md",
			"Shared/p/b.md",
		]);
		session.state = advanceSessionAfterPush(session.state, first, manifest);
		session.adapter.putText("a.md", "A2");
		return session;
	}

	it("leaves the frozen entries out of the manifest and records them as deleted, so GC can sweep their blobs", async () => {
		const session = await vaultWithFrozenCopy();
		const deps = {
			...session.deps(),
			scope: vaultScope,
			history: { maxSnapshots: 50 },
		};
		const result = await compare(deps);
		expect(result.remote?.files["Shared/p/b.md"]).toBeDefined();

		const published = await pushPaths(deps, result, ["a.md"]);

		expect(Object.keys(published.files)).toEqual(["a.md"]);
		const log = await readHistoryLog(
			session.storage,
			deps.key,
			deps.space.root,
		);
		expect(
			Object.keys(log.changes[published.snapshotId]?.deleted ?? {}),
		).toEqual(["Shared/p/b.md"]);
	});

	it("frees the folder's blobs once the prune rolls off the history", async () => {
		const session = await vaultWithFrozenCopy();
		const frozenBlob = objectKey(
			(await session.compare()).remote?.files["Shared/p/b.md"]?.hash ?? "",
		);
		expect(await session.storage.exists(frozenBlob)).toBe(true);

		for (let edit = 2; edit < 40; edit++) {
			const deps = {
				...session.deps(),
				scope: vaultScope,
				history: { maxSnapshots: 1 },
			};
			session.adapter.putText("a.md", `A${edit}`);
			const result = await compare(deps);
			const published = await pushPaths(deps, result, ["a.md"]);
			session.state = advanceSessionAfterPush(session.state, result, published);
		}

		expect(await session.storage.exists(frozenBlob)).toBe(false);
	});

	it("still publishes a frozen entry while no share holds the folder", async () => {
		const session = await vaultWithFrozenCopy();
		const deps = session.deps();
		const result = await compare(deps);
		const published = await pushPaths(deps, result, ["a.md"]);
		expect(Object.keys(published.files)).toEqual(["Shared/p/b.md", "a.md"]);
	});
});
