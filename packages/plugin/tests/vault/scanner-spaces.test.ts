import { InMemoryAdapter } from "@tests/helpers/in-memory-adapter";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS_SYNC } from "@/settings/model";
import { diff } from "@/sync/diff";
import type { HashCacheEntry, Manifest, ManifestEntry } from "@/sync/types";
import { scanVault } from "@/vault/scanner";
import { createScopePolicy, type ScopeOptions } from "@/vault/scope";

const CONFIG = ".obsidian";
const options = { maxFileBytes: 1000, concurrency: 2 };

function policy(extra: Partial<ScopeOptions> = {}) {
	return createScopePolicy({
		settingsSync: DEFAULT_SETTINGS_SYNC,
		configDir: CONFIG,
		...extra,
	});
}

function vault(files: Record<string, string>): InMemoryAdapter {
	const adapter = new InMemoryAdapter();
	for (const [path, text] of Object.entries(files)) adapter.putText(path, text);
	return adapter;
}

function manifestOf(files: Record<string, ManifestEntry>): Manifest {
	return {
		version: 1,
		vaultId: "v",
		snapshotId: "s",
		parentSnapshotId: null,
		createdAt: 0,
		deviceId: "d",
		files,
	};
}

describe("scanner carry-forward for unowned cache entries", () => {
	it("share-rooted scan carries forward vault entries", async () => {
		const adapter = vault({
			"notes/a.md": "vault note",
			"shared/photos/pic.png": "photo bytes",
		});

		const vaultScope = policy();
		const full = await scanVault(
			adapter.asDataAdapter(),
			vaultScope,
			options,
			{},
		);
		expect(full.updatedCache["notes/a.md"]).toBeDefined();
		expect(full.updatedCache["shared/photos/pic.png"]).toBeDefined();

		const shareScope = policy({ root: "shared/photos" });
		const shareScan = await scanVault(
			adapter.asDataAdapter(),
			shareScope,
			options,
			full.updatedCache,
		);

		expect(shareScan.snapshot.files["shared/photos/pic.png"]).toBeDefined();
		expect(shareScan.snapshot.files["notes/a.md"]).toBeUndefined();

		expect(shareScan.updatedCache["notes/a.md"]).toBeDefined();
		expect(shareScan.updatedCache["shared/photos/pic.png"]).toBeDefined();
	});

	it("vault scope scan carries forward share entries", async () => {
		const adapter = vault({
			"notes/a.md": "vault note",
			"shared/photos/pic.png": "photo bytes",
		});

		const fullScope = policy();
		const full = await scanVault(
			adapter.asDataAdapter(),
			fullScope,
			options,
			{},
		);

		const vaultScope = policy({ otherRoots: ["shared/photos"] });
		const vaultScan = await scanVault(
			adapter.asDataAdapter(),
			vaultScope,
			options,
			full.updatedCache,
		);

		expect(vaultScan.snapshot.files["notes/a.md"]).toBeDefined();
		expect(vaultScan.snapshot.files["shared/photos/pic.png"]).toBeUndefined();

		expect(vaultScan.updatedCache["shared/photos/pic.png"]).toBeDefined();
		expect(vaultScan.updatedCache["notes/a.md"]).toBeDefined();
	});

	it("un-owned cache entries do not bleed into the snapshot", async () => {
		const adapter = vault({ "shared/photos/pic.png": "photo" });
		const foreignCache: Record<string, HashCacheEntry> = {
			"notes/a.md": { mtime: 100, size: 10, hash: "foreign-hash" },
		};

		const shareScope = policy({ root: "shared/photos" });
		const result = await scanVault(
			adapter.asDataAdapter(),
			shareScope,
			options,
			foreignCache,
		);

		expect(result.snapshot.files["notes/a.md"]).toBeUndefined();
		expect(result.updatedCache["notes/a.md"]).toBeDefined();
	});
});

describe("vault baseline entries under a share root are frozen", () => {
	it("vault scope with otherRoots does not delete or publish share entries", async () => {
		const adapter = vault({
			"notes/a.md": "vault note",
			"shared/photos/pic.png": "photo",
		});

		const fullScope = policy();
		const full = await scanVault(
			adapter.asDataAdapter(),
			fullScope,
			options,
			{},
		);
		const synced = manifestOf(full.snapshot.files);

		const vaultScope = policy({ otherRoots: ["shared/photos"] });
		const vaultScan = await scanVault(
			adapter.asDataAdapter(),
			vaultScope,
			options,
			full.updatedCache,
		);

		const result = diff({
			local: vaultScan.snapshot,
			remote: synced,
			baseline: synced,
			includes: (p) => vaultScope.includes(p),
		});

		// The share path must not appear as a local delete.
		expect(result.localChanges).toHaveLength(0);
		expect(result.remoteChanges).toHaveLength(0);
		expect(result.conflicts).toHaveLength(0);
	});

	it("share scope does not delete or publish vault entries", async () => {
		const adapter = vault({
			"notes/a.md": "vault note",
			"shared/photos/pic.png": "photo",
		});

		const fullScope = policy();
		const full = await scanVault(
			adapter.asDataAdapter(),
			fullScope,
			options,
			{},
		);
		const synced = manifestOf(full.snapshot.files);

		const shareScope = policy({ root: "shared/photos" });
		const shareScan = await scanVault(
			adapter.asDataAdapter(),
			shareScope,
			options,
			full.updatedCache,
		);

		const result = diff({
			local: shareScan.snapshot,
			remote: synced,
			baseline: synced,
			includes: (p) => shareScope.includes(p),
		});

		expect(result.localChanges).toHaveLength(0);
		expect(result.remoteChanges).toHaveLength(0);
		expect(result.conflicts).toHaveLength(0);
	});
});
