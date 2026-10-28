import { FakeStorage } from "@tests/helpers/fake-storage";
import { pinSnapshot, seedChain } from "@tests/helpers/history";
import { beforeAll, describe, expect, it } from "vitest";
import { deriveKey, type EncryptionKey } from "@/core/crypto/cipher";
import { diffManifests, undoChanges } from "@/features/sync/history/changes";
import { getFileHistory, readTimeline } from "@/features/sync/history/query";
import { pushKey } from "@/features/sync/history/remote";
import { replayTo } from "@/features/sync/history/replay";
import type { EFileKind, Manifest, ManifestEntry } from "@/features/sync/types";

let key: EncryptionKey;
beforeAll(async () => {
	key = await deriveKey("pw", new Uint8Array(16));
});

function entry(hash: string, size = 1, mtime = 1): ManifestEntry {
	return { hash, size, mtime, kind: "vault" as EFileKind };
}

function manifest(
	snapshotId: string,
	parentSnapshotId: string | null,
	files: Record<string, ManifestEntry>,
	createdAt = 1,
): Manifest {
	return {
		version: 1,
		vaultId: "v",
		snapshotId,
		parentSnapshotId,
		createdAt,
		deviceId: "d",
		deviceName: "Device",
		files,
	};
}

/** Deterministic chain: each step adds, edits and deletes a few paths. */
function generateChain(steps: number): Manifest[] {
	let seed = 42;
	const random = (): number => {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		return seed / 2147483648;
	};
	const chain: Manifest[] = [];
	let files: Record<string, ManifestEntry> = {};
	let parent: string | null = null;
	for (let step = 0; step < steps; step++) {
		files = { ...files };
		for (let n = 0; n < 3; n++) {
			files[`note-${step}-${n}.md`] = entry(`h${step}-${n}`, step + n, step);
		}
		const paths = Object.keys(files);
		for (let n = 0; n < 2 && paths.length > 0; n++) {
			const victim = paths[Math.floor(random() * paths.length)];
			if (!victim) continue;
			if (random() < 0.5) {
				delete files[victim];
			} else {
				files[victim] = entry(`edit${step}-${n}`, step + 10, step + 1);
			}
		}
		const id = `s${step}`;
		chain.push(manifest(id, parent, files, step + 1));
		parent = id;
	}
	return chain;
}

async function seed(
	chain: readonly Manifest[],
	skip: readonly string[] = [],
): Promise<FakeStorage> {
	const storage = new FakeStorage();
	await seedChain(storage, key, chain, skip);
	return storage;
}

function historyOf(storage: FakeStorage, path: string) {
	return getFileHistory({ storage, key, root: "", path });
}

describe("diffManifests / undoChanges", () => {
	it("classifies added, modified and deleted", () => {
		const parent = manifest("s1", null, { a: entry("A1"), gone: entry("G1") });
		const next = manifest("s2", "s1", { a: entry("A2"), fresh: entry("F1") });
		const changes = diffManifests(parent, next);

		expect(Object.keys(changes.added)).toEqual(["fresh"]);
		expect(changes.modified.a).toEqual({ from: entry("A1"), to: entry("A2") });
		expect(changes.deleted.gone).toEqual(entry("G1"));
	});

	it("treats a null parent as everything added", () => {
		const changes = diffManifests(
			null,
			manifest("s1", null, { a: entry("A1") }),
		);
		expect(Object.keys(changes.added)).toEqual(["a"]);
		expect(changes.deleted).toEqual({});
	});

	it("records a metadata-only change so the parent stays reproducible", () => {
		const parent = manifest("s1", null, { a: entry("A1", 1, 100) });
		const next = manifest("s2", "s1", { a: entry("A1", 1, 200) });
		const changes = diffManifests(parent, next);
		expect(changes.modified.a?.from.mtime).toBe(100);
		const files = { ...next.files };
		undoChanges(files, changes);
		expect(files).toEqual(parent.files);
	});

	it("classifies a file named like an Object member as added, not modified", () => {
		// Plain index access would return Object.prototype.toString here.
		const next = manifest("s1", null, { toString: entry("T1") });
		const changes = diffManifests(manifest("s0", null, {}), next);
		expect(Object.keys(changes.added)).toEqual(["toString"]);
		expect(changes.modified).toEqual({});
	});

	it("undo is the exact inverse across a generated chain", () => {
		const chain = generateChain(25);
		for (let index = 1; index < chain.length; index++) {
			const parent = chain[index - 1] as Manifest;
			const current = chain[index] as Manifest;
			const changes = diffManifests(parent, current);
			const files = { ...current.files };
			undoChanges(files, changes);
			expect(files).toEqual(parent.files);
		}
	});
});

describe("readTimeline", () => {
	it("reads no head and an empty walk from an empty remote", async () => {
		const { head, cover } = await readTimeline({
			storage: new FakeStorage(),
			key,
			root: "",
		});
		expect(head).toBeNull();
		expect(cover).toMatchObject({
			chain: [],
			lagging: false,
			truncated: false,
		});
	});

	it("walks HEAD back to the first push", async () => {
		const storage = await seed(generateChain(4));

		const { head, cover } = await readTimeline({ storage, key, root: "" });
		expect(head?.snapshotId).toBe("s3");
		expect(cover.chain.map(({ record }) => record.id)).toEqual([
			"s3",
			"s2",
			"s1",
			"s0",
		]);
		expect(cover).toMatchObject({ lagging: false, truncated: false });
	});

	it("is lagging, not truncated, while HEAD has no record", async () => {
		const storage = await seed(generateChain(3), ["s2"]);

		const { cover } = await readTimeline({ storage, key, root: "" });
		expect(cover.chain.map(({ record }) => record.id)).toEqual(["s1", "s0"]);
		expect(cover).toMatchObject({ lagging: true, truncated: false });
	});

	it("is truncated at a record that is missing", async () => {
		const storage = await seed(generateChain(4), ["s1"]);

		const { cover } = await readTimeline({ storage, key, root: "" });
		expect(cover.chain.map(({ record }) => record.id)).toEqual(["s3", "s2"]);
		expect(cover).toMatchObject({ lagging: false, truncated: true });
	});

	it("reads a corrupt record as a gap, never as an empty history", async () => {
		const storage = await seed(generateChain(4));
		await storage.put(
			pushKey("s2"),
			crypto.getRandomValues(new Uint8Array(64)),
		);

		const { cover } = await readTimeline({ storage, key, root: "" });
		expect(cover.chain.map(({ record }) => record.id)).toEqual(["s3"]);
		expect(cover).toMatchObject({ lagging: false, truncated: true });
	});
});

describe("replayTo", () => {
	async function replay(
		storage: FakeStorage,
		snapshotId: string,
	): Promise<Manifest | null> {
		const { head, cover } = await readTimeline({ storage, key, root: "" });
		if (!head) throw new Error("no head");
		return replayTo(head, cover, snapshotId);
	}

	it("reproduces every manifest in the chain", async () => {
		const chain = generateChain(20);
		const storage = await seed(chain);
		const { head, cover } = await readTimeline({ storage, key, root: "" });
		if (!head) throw new Error("no head");
		for (const target of chain) {
			const replayed = replayTo(head, cover, target.snapshotId);
			expect(replayed?.files).toEqual(target.files);
			expect(replayed?.snapshotId).toBe(target.snapshotId);
			expect(replayed?.createdAt).toBe(target.createdAt);
		}
	});

	it("does not hand back HEAD's own file map", async () => {
		const chain = generateChain(3);
		const storage = await seed(chain);
		const { head, cover } = await readTimeline({ storage, key, root: "" });
		if (!head) throw new Error("no head");
		const replayed = replayTo(head, cover, head.snapshotId);
		expect(replayed?.files).toEqual(head.files);
		expect(replayed?.files).not.toBe(head.files);
	});

	it("refuses while HEAD has no record", async () => {
		const storage = await seed(generateChain(4), ["s3"]);
		expect(await replay(storage, "s0")).toBeNull();
	});

	it("refuses to replay past a gap", async () => {
		const storage = await seed(generateChain(5), ["s2"]);
		expect(await replay(storage, "s3")).not.toBeNull();
		expect(await replay(storage, "s1")).toBeNull();
	});

	it("refuses a snapshot the walk never reaches", async () => {
		const storage = await seed(generateChain(3));
		expect(await replay(storage, "elsewhere")).toBeNull();
	});
});

describe("getFileHistory", () => {
	it("returns distinct versions newest first and skips unchanged pushes", async () => {
		const storage = await seed([
			manifest("s1", null, { "a.md": entry("A1") }, 100),
			manifest("s2", "s1", { "a.md": entry("A1") }, 200),
			manifest("s3", "s2", { "a.md": entry("A2") }, 300),
		]);

		const versions = await historyOf(storage, "a.md");
		expect(versions.map((v) => v.hash)).toEqual(["A2", "A1"]);
		// The A1 version is attributed to the newest snapshot holding it.
		expect(versions.map((v) => v.snapshotId)).toEqual(["s3", "s2"]);
		expect(versions.map((v) => v.createdAt)).toEqual([300, 200]);
	});

	it("marks the version that created the file, in each of its lifetimes", async () => {
		const storage = await seed([
			manifest("s1", null, { "a.md": entry("A1") }, 100),
			manifest("s2", "s1", { "a.md": entry("A2") }, 200),
			manifest("s3", "s2", {}, 300),
			manifest("s4", "s3", { "a.md": entry("A3") }, 400),
		]);

		const versions = await historyOf(storage, "a.md");
		expect(versions.map((v) => [v.hash, v.first])).toEqual([
			["A3", true],
			["A2", false],
			["A1", true],
		]);
		expect(versions.map((v) => [v.res, v.pushes])).toEqual([
			["push", 1],
			["push", 1],
			["push", 1],
		]);
	});

	it("returns nothing for a path the history never saw", async () => {
		const storage = await seed([manifest("s1", null, { "a.md": entry("A1") })]);
		expect(await historyOf(storage, "b.md")).toEqual([]);
	});

	it("returns nothing when no vault is published", async () => {
		expect(await historyOf(new FakeStorage(), "a.md")).toEqual([]);
	});

	it("still finds a file that was deleted", async () => {
		const storage = await seed([
			manifest("s1", null, { "gone.md": entry("G1") }, 100),
			manifest("s2", "s1", { "gone.md": entry("G2") }, 200),
			manifest("s3", "s2", {}, 300),
		]);

		const versions = await historyOf(storage, "gone.md");
		expect(versions.map((v) => v.hash)).toEqual(["G2", "G1"]);
	});

	it("separates a recreated file from its earlier life", async () => {
		const storage = await seed([
			manifest("s1", null, { "a.md": entry("A1") }, 100),
			manifest("s2", "s1", {}, 200),
			manifest("s3", "s2", { "a.md": entry("A1") }, 300),
		]);

		const versions = await historyOf(storage, "a.md");
		// Same content, but two distinct lifetimes - neither may swallow the other.
		expect(versions.map((v) => v.snapshotId)).toEqual(["s3", "s1"]);
	});

	it("orders by the chain, not by device clocks", async () => {
		// s2 is the child of s1 but carries an earlier timestamp, as a device with
		// a lagging clock would produce.
		const storage = await seed([
			manifest("s1", null, { "a.md": entry("A1") }, 5000),
			manifest("s2", "s1", { "a.md": entry("A2") }, 1000),
		]);

		const versions = await historyOf(storage, "a.md");
		expect(versions.map((v) => v.hash)).toEqual(["A2", "A1"]);
	});

	it("marks and names a version whose snapshot is pinned", async () => {
		const chain = [
			manifest("s1", null, { "a.md": entry("A1") }, 100),
			manifest("s2", "s1", { "a.md": entry("A2") }, 200),
			manifest("s3", "s2", { "a.md": entry("A3") }, 300),
		];
		const storage = await seed(chain);
		await pinSnapshot(storage, key, chain[1] as Manifest, "keeper");

		const versions = await historyOf(storage, "a.md");
		expect(versions.map((v) => [v.hash, v.pinned, v.label])).toEqual([
			["A3", false, undefined],
			["A2", true, "keeper"],
			["A1", false, undefined],
		]);
	});

	it("surfaces a pin sitting past a missing record", async () => {
		const chain = [
			manifest("s1", null, { "a.md": entry("A1") }, 100),
			manifest("s2", "s1", { "a.md": entry("A2") }, 200),
			manifest("s3", "s2", { "a.md": entry("A3") }, 300),
		];
		// s2's record is lost, so the walk stops there and must not claim to have
		// covered s1: only its pin reaches it.
		const storage = await seed(chain, ["s2"]);
		await pinSnapshot(storage, key, chain[0] as Manifest);

		const versions = await historyOf(storage, "a.md");
		expect(versions.map((v) => v.hash)).toEqual(["A3", "A1"]);
		expect(versions[0]?.pinned).toBe(false);
		expect(versions[1]?.pinned).toBe(true);
		expect(versions[1]?.snapshotId).toBe("s1");
	});

	it("keeps to what a corrupt record leaves reachable", async () => {
		const chain = [
			manifest("s1", null, { "a.md": entry("A1") }, 100),
			manifest("s2", "s1", { "a.md": entry("A2") }, 200),
			manifest("s3", "s2", { "a.md": entry("A3") }, 300),
		];
		const storage = await seed(chain);
		await storage.put(
			pushKey("s2"),
			crypto.getRandomValues(new Uint8Array(64)),
		);

		const versions = await historyOf(storage, "a.md");
		expect(versions.map((v) => v.hash)).toEqual(["A3"]);
	});

	it("serves the current version while HEAD has no record", async () => {
		const storage = await seed(
			[
				manifest("s1", null, { "a.md": entry("A1") }, 100),
				manifest("s2", "s1", { "a.md": entry("A2") }, 200),
			],
			["s2"],
		);

		const versions = await historyOf(storage, "a.md");
		expect(versions.map((v) => v.hash)).toEqual(["A2"]);
		expect(versions[0]?.snapshotId).toBe("s2");
	});
});
