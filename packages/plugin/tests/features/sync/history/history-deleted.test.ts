import { FakeStorage } from "@tests/helpers/fake-storage";
import {
	pinSnapshot,
	seedChain,
	writePushRecord,
} from "@tests/helpers/history";
import { publishManifest } from "@tests/helpers/manifest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { deriveKey, type EncryptionKey } from "@/core/crypto/cipher";
import { keptUntil } from "@/features/sync/history/model/periods";
import { pinKey } from "@/features/sync/history/pins";
import { listDeletedFiles, listSnapshots } from "@/features/sync/history/query";
import { pushKey } from "@/features/sync/history/remote";
import { manifestToSpace } from "@/features/sync/remote/space-paths";
import type { EFileKind, Manifest, ManifestEntry } from "@/features/sync/types";

const MINUTE = 60_000;
const HORIZON = 30 * 24 * 60 * MINUTE;
const NOW = Date.UTC(2026, 0, 14, 10);

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

async function seed(
	chain: readonly Manifest[],
	skip: readonly string[] = [],
): Promise<FakeStorage> {
	const storage = new FakeStorage();
	await seedChain(storage, key, chain, skip);
	return storage;
}

/** Dates the push records as storage would, a minute apart in chain order. */
function stamp(storage: FakeStorage, ids: readonly string[]): void {
	for (const [index, id] of ids.entries()) {
		storage.modified.set(pushKey(id), NOW + index * MINUTE);
	}
}

function deleted(storage: FakeStorage, horizon: number | null = null) {
	return listDeletedFiles({ storage, key, root: "", horizon });
}

function snapshots(storage: FakeStorage, horizon: number | null = null) {
	return listSnapshots({ storage, key, root: "", horizon });
}

describe("listDeletedFiles", () => {
	it("reports a deleted file with the content it had when it went", async () => {
		const storage = await seed([
			manifest("s1", null, { keep: entry("K1"), gone: entry("G1", 42) }, 100),
			manifest("s2", "s1", { keep: entry("K1") }, 200),
		]);

		const result = await deleted(storage);

		expect(result.lagging).toBe(false);
		expect(result.files).toHaveLength(1);
		const [file] = result.files;
		expect(file?.path).toBe("gone");
		expect(file?.entry).toEqual(entry("G1", 42));
		// The snapshot that removed it, not the one that last held it.
		expect(file?.snapshotId).toBe("s2");
		expect(file?.createdAt).toBe(200);
		expect(file?.source).toBe("deleted");
		expect(file?.pinned).toBe(false);
		expect(file?.keptUntil).toBeNull();
	});

	it("gives an unpinned deletion a retention deadline past its record", async () => {
		const storage = await seed([
			manifest("s1", null, { gone: entry("G1") }, 100),
			manifest("s2", "s1", {}, 200),
		]);
		stamp(storage, ["s1", "s2"]);

		const [file] = (await deleted(storage, HORIZON)).files;

		expect(file?.pinned).toBe(false);
		expect(file?.keptUntil).toBe(keptUntil(NOW + MINUTE, HORIZON));
		expect(file?.keptUntil).toBeGreaterThan(NOW + MINUTE + HORIZON);
	});

	it("omits a file that came back", async () => {
		const storage = await seed([
			manifest("s1", null, { a: entry("A1") }, 100),
			manifest("s2", "s1", {}, 200),
			manifest("s3", "s2", { a: entry("A2") }, 300),
		]);

		expect((await deleted(storage)).files).toEqual([]);
	});

	it("reports the latest death of a recreated-then-deleted file", async () => {
		const storage = await seed([
			manifest("a", null, { note: entry("V1") }, 100),
			manifest("b", "a", {}, 200),
			manifest("c", "b", { note: entry("V2") }, 300),
			manifest("d", "c", {}, 400),
		]);

		const result = await deleted(storage);
		expect(result.files).toHaveLength(1);
		expect(result.files[0]?.snapshotId).toBe("d");
		expect(result.files[0]?.entry.hash).toBe("V2");
	});

	it("never reports an older death of a file HEAD's missing record deleted again", async () => {
		const storage = await seed(
			[
				manifest("a", null, { note: entry("V1") }, 100),
				manifest("b", "a", {}, 200),
				manifest("c", "b", { note: entry("V2") }, 300),
				manifest("d", "c", {}, 400),
			],
			["d"],
		);

		const result = await deleted(storage);
		expect(result.lagging).toBe(true);
		expect(result.files).toEqual([]);
	});

	it("orders by the chain, not by device clock", async () => {
		// The newer snapshot carries the older timestamp.
		const storage = await seed([
			manifest("s1", null, { old: entry("O1"), recent: entry("R1") }, 100),
			manifest("s2", "s1", { recent: entry("R1") }, 9000),
			manifest("s3", "s2", {}, 200),
		]);

		const result = await deleted(storage);
		expect(result.files.map((f) => [f.path, f.snapshotId])).toEqual([
			["recent", "s3"],
			["old", "s2"],
		]);
	});

	it("stops at a gap instead of attributing deletions to the wrong snapshot", async () => {
		const storage = await seed(
			[
				manifest("s1", null, { early: entry("E1"), late: entry("L1") }, 100),
				manifest("s2", "s1", { early: entry("E1") }, 200),
				manifest("s3", "s2", {}, 300),
			],
			["s2"],
		);

		const result = await deleted(storage);
		expect(result.files.map((f) => f.path)).toEqual(["early"]);
		expect(result.files[0]?.snapshotId).toBe("s3");
	});

	it("flags a history that has not caught up with HEAD", async () => {
		const storage = await seed(
			[
				manifest("s1", null, { a: entry("A1") }, 100),
				manifest("s2", "s1", {}, 200),
			],
			["s2"],
		);

		const result = await deleted(storage);
		expect(result.lagging).toBe(true);
		expect(result.truncated).toBe(false);
		expect(result.files).toEqual([]);
	});

	it("reports a gap as truncated, not as a healthy empty trash", async () => {
		const storage = await seed(
			[
				manifest("s1", null, { a: entry("A1") }, 100),
				manifest("s2", "s1", {}, 200),
				manifest("s3", "s2", {}, 300),
			],
			["s2"],
		);

		const result = await deleted(storage);
		expect(result.lagging).toBe(false);
		expect(result.truncated).toBe(true);
		expect(result.files).toEqual([]);
	});

	it("reads a corrupt push record as a gap, not as an empty history", async () => {
		const storage = await seed([
			manifest("s1", null, { a: entry("A1"), b: entry("B1") }, 100),
			manifest("s2", "s1", { b: entry("B1") }, 200),
			manifest("s3", "s2", {}, 300),
		]);
		await storage.put(
			pushKey("s2"),
			crypto.getRandomValues(new Uint8Array(64)),
		);

		const result = await deleted(storage);
		expect(result.lagging).toBe(false);
		expect(result.truncated).toBe(true);
		// What s3 removed is still known; what s2 removed is not.
		expect(result.files.map((f) => f.path)).toEqual(["b"]);
		expect((await snapshots(storage)).snapshots.map((s) => s.id)).toEqual([
			"s3",
		]);
	});

	it("returns a share's deleted file in vault paths", async () => {
		const root = "Shared/p";
		const first = manifest(
			"s1",
			null,
			{
				[`${root}/keep.md`]: entry("K1"),
				[`${root}/gone.md`]: entry("G1", 42),
			},
			100,
		);
		const second = manifest(
			"s2",
			"s1",
			{ [`${root}/keep.md`]: entry("K1") },
			200,
		);
		const storage = new FakeStorage();
		await writePushRecord(storage, key, first, null, root);
		await writePushRecord(storage, key, second, first, root);
		await publishManifest(storage, key, manifestToSpace(second, root));

		const result = await listDeletedFiles({
			storage,
			key,
			root,
			horizon: null,
		});

		expect(result.files.map((f) => [f.path, f.snapshotId])).toEqual([
			[`${root}/gone.md`, "s2"],
		]);
		expect(result.files[0]?.entry).toEqual(entry("G1", 42));
	});

	it("prefers the chain record over a pin describing the same file", async () => {
		const chain = [
			manifest("s1", null, { ancient: entry("A1", 7) }, 100),
			manifest("s2", "s1", {}, 200),
		];
		const storage = await seed(chain);
		await pinSnapshot(storage, key, chain[0] as Manifest);

		const result = await deleted(storage);
		// The chain records the deletion, so that record wins over the pin.
		expect(result.files.map((f) => f.path)).toEqual(["ancient"]);
		expect(result.files[0]?.source).toBe("deleted");
		expect(result.files[0]?.snapshotId).toBe("s2");
	});

	it("falls back to the pin when no change record explains the loss", async () => {
		const storage = await seed([
			manifest("s9", "s8", { kept: entry("K1") }, 900),
		]);
		await pinSnapshot(
			storage,
			key,
			manifest("old", null, { kept: entry("K0"), lost: entry("L1", 5) }, 100),
		);

		const result = await deleted(storage, HORIZON);
		expect(result.truncated).toBe(true);
		expect(result.files).toHaveLength(1);
		expect(result.files[0]?.path).toBe("lost");
		expect(result.files[0]?.source).toBe("pinned");
		expect(result.files[0]?.pinned).toBe(true);
		expect(result.files[0]?.keptUntil).toBeNull();
	});

	it("lists a deleted file named like an Object member", async () => {
		const storage = await seed([
			manifest("s1", null, { toString: entry("T1") }, 100),
			manifest("s2", "s1", {}, 200),
		]);

		const result = await deleted(storage);
		expect(result.files.map((f) => f.path)).toEqual(["toString"]);
	});

	it("clears retention only for what a pin holds", async () => {
		const chain = [
			manifest("s1", null, { a: entry("A1"), b: entry("B1") }, 100),
			manifest("s2", "s1", { a: entry("A1") }, 200),
			manifest("s3", "s2", {}, 300),
		];
		const storage = await seed(chain);
		await pinSnapshot(storage, key, chain[1] as Manifest);

		const result = await deleted(storage, HORIZON);
		expect(
			result.files.map((f) => [f.path, f.pinned, f.keptUntil !== null]),
		).toEqual([
			["a", true, false],
			["b", false, true],
		]);
	});

	it("keeps the countdown when a pin holds another version of the file", async () => {
		const chain = [
			manifest("p", null, { f: entry("F1") }, 100),
			manifest("s2", "p", { f: entry("F2") }, 200),
			manifest("s3", "s2", {}, 300),
		];
		const storage = await seed(chain);
		stamp(storage, ["p", "s2", "s3"]);
		await pinSnapshot(storage, key, chain[0] as Manifest);

		const result = await deleted(storage, HORIZON);
		expect(result.files).toHaveLength(1);
		expect(result.files[0]?.entry.hash).toBe("F2");
		expect(result.files[0]?.pinned).toBe(false);
		expect(result.files[0]?.keptUntil).toBe(
			keptUntil(NOW + 2 * MINUTE, HORIZON),
		);
	});

	it("drops the countdown when an older pin holds the same version", async () => {
		const chain = [
			manifest("p", null, { doomed: entry("D1") }, 100),
			manifest("s2", "p", { doomed: entry("D1") }, 200),
			manifest("s3", "s2", {}, 300),
		];
		const storage = await seed(chain);
		await pinSnapshot(storage, key, chain[0] as Manifest);

		const result = await deleted(storage, HORIZON);
		expect(result.files).toHaveLength(1);
		// The deletion is dated from the chain, but the pin means it never ages out.
		expect(result.files[0]?.source).toBe("deleted");
		expect(result.files[0]?.createdAt).toBe(300);
		expect(result.files[0]?.pinned).toBe(true);
		expect(result.files[0]?.keptUntil).toBeNull();
	});

	it("still reaches a pin sitting past a gap in the chain", async () => {
		const chain = [
			manifest("p", null, { archived: entry("R1", 9) }, 100),
			manifest("s2", "p", {}, 200),
			manifest("s3", "s2", {}, 300),
		];
		const storage = await seed(chain, ["s2"]);
		await pinSnapshot(storage, key, chain[0] as Manifest);

		const result = await deleted(storage);
		expect(result.truncated).toBe(true);
		expect(result.files.map((f) => f.path)).toEqual(["archived"]);
		expect(result.files[0]?.source).toBe("pinned");
	});

	it("lets the newest pin win however the pin reads finish", async () => {
		const chain = [
			manifest("p1", null, { f: entry("F1") }, 100),
			manifest("p2", "p1", { f: entry("F2"), g: entry("G2") }, 200),
			manifest("p3", "p2", { f: entry("F3") }, 300),
			manifest("s4", "p3", {}, 400),
		];
		// With no record for p3 or s4 the walk reaches nothing, so the pins alone explain the files.
		const storage = await seed(chain, ["p3", "s4"]);
		const delays: Record<string, number> = { p1: 0, p2: 15, p3: 30 };
		for (const pinned of chain.slice(0, 3)) {
			await pinSnapshot(storage, key, pinned);
		}
		const get = storage.get.bind(storage);
		vi.spyOn(storage, "get").mockImplementation(async (path) => {
			const id = Object.keys(delays).find((pin) => path === pinKey(pin));
			if (id) await new Promise((r) => setTimeout(r, delays[id]));
			return get(path);
		});

		const result = await deleted(storage);
		const byPath = Object.fromEntries(
			result.files.map((file) => [file.path, file]),
		);
		expect(byPath.f?.snapshotId).toBe("p3");
		expect(byPath.f?.entry.hash).toBe("F3");
		expect(byPath.g?.snapshotId).toBe("p2");
		expect(result.files.every((file) => file.pinned)).toBe(true);
	});

	it("keeps rows, order and marks when several pins share absent paths", async () => {
		const chain = [
			manifest(
				"w1",
				null,
				{ k: entry("K1"), walked: entry("W1"), other: entry("O1") },
				100,
			),
			manifest("w2", "w1", { k: entry("K1") }, 200),
		];
		const storage = await seed(chain);
		// Newest first: p2 (500), then the 400 tie in read order (p4 is read before p3), then p1 (300).
		const pins = [
			manifest(
				"p1",
				null,
				{
					k: entry("K1"),
					early: entry("E1"),
					shared: entry("S1"),
					walked: entry("W1"),
					other: entry("O0"),
				},
				300,
			),
			manifest(
				"p2",
				null,
				{ shared: entry("S2"), walked: entry("W2"), solo: entry("X2") },
				500,
			),
			manifest(
				"p3",
				null,
				{ shared: entry("S3"), tied: entry("T3"), mid: entry("M3") },
				400,
			),
			manifest("p4", null, { tied: entry("T4"), shared: entry("S4") }, 400),
		];
		const delays: Record<string, number> = { p1: 40, p2: 0, p3: 25, p4: 5 };
		for (const pinned of pins) await pinSnapshot(storage, key, pinned);
		const get = storage.get.bind(storage);
		vi.spyOn(storage, "get").mockImplementation(async (path) => {
			const id = Object.keys(delays).find((pin) => path === pinKey(pin));
			if (id) await new Promise((r) => setTimeout(r, delays[id]));
			return get(path);
		});

		const result = await deleted(storage, HORIZON);
		expect(
			result.files.map((file) => [
				file.path,
				file.source,
				file.snapshotId,
				file.entry.hash,
				file.pinned,
				file.keptUntil !== null,
			]),
		).toEqual([
			// The walk's rows come first; a pin marks one only for the hash it holds.
			["walked", "deleted", "w2", "W1", true, false],
			["other", "deleted", "w2", "O1", false, true],
			["shared", "pinned", "p2", "S2", true, false],
			["solo", "pinned", "p2", "X2", true, false],
			["tied", "pinned", "p4", "T4", true, false],
			["mid", "pinned", "p3", "M3", true, false],
			["early", "pinned", "p1", "E1", true, false],
		]);
	});

	it("returns nothing when no vault is published", async () => {
		const storage = new FakeStorage();
		const result = await deleted(storage);
		expect(result).toEqual({ files: [], lagging: false, truncated: false });
	});
});

describe("listSnapshots", () => {
	it("surfaces full before/after manifest metadata per file", async () => {
		const storage = await seed([
			manifest("s1", null, { a: entry("A1", 10), b: entry("B1", 20) }, 100),
			manifest("s2", "s1", { a: entry("A2", 15), c: entry("C1", 5) }, 200),
		]);

		const result = await snapshots(storage);
		expect(result.lagging).toBe(false);
		expect(result.snapshots.map((s) => s.id)).toEqual(["s2", "s1"]);
		expect(result.snapshots.map((s) => s.keptUntil)).toEqual([null, null]);

		expect(result.snapshots[0]?.files).toEqual({
			added: { c: entry("C1", 5) },
			modified: { a: { from: entry("A1", 10), to: entry("A2", 15) } },
			deleted: { b: entry("B1", 20) },
		});
		expect(result.snapshots[1]?.files?.added).toEqual({
			a: entry("A1", 10),
			b: entry("B1", 20),
		});
	});

	it("gives each unpinned snapshot a deadline past its record and a pinned one none", async () => {
		const chain = [
			manifest("s1", null, { a: entry("A1") }, 100),
			manifest("s2", "s1", { a: entry("A2") }, 200),
			manifest("s3", "s2", { a: entry("A3") }, 300),
		];
		const storage = await seed(chain);
		stamp(storage, ["s1", "s2", "s3"]);
		await pinSnapshot(storage, key, chain[1] as Manifest);

		const { snapshots: rows } = await snapshots(storage, HORIZON);
		const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
		expect(byId.s1?.keptUntil).toBeGreaterThan(NOW + HORIZON);
		expect(byId.s3?.keptUntil).toBeGreaterThan(NOW + 2 * MINUTE + HORIZON);
		expect(byId.s3?.keptUntil).toBe(keptUntil(NOW + 2 * MINUTE, HORIZON));
		expect(byId.s2?.pinned).toBe(true);
		expect(byId.s2?.keptUntil).toBeNull();
	});

	it("dates each snapshot by storage and counts its pushes per hour", async () => {
		const storage = await seed([
			manifest("s1", null, { a: entry("A1") }, 100),
			manifest("s2", "s1", { a: entry("A2") }, 200),
		]);
		stamp(storage, ["s1", "s2"]);

		const result = await snapshots(storage);
		expect(
			result.snapshots.map((s) => [s.id, s.at, s.firstAt, s.pushes, s.res]),
		).toEqual([
			["s2", NOW + MINUTE, NOW + MINUTE, 1, "push"],
			["s1", NOW, NOW, 1, "push"],
		]);
		const pushes = Object.values(result.activity).reduce(
			(sum, [count]) => sum + count,
			0,
		);
		expect(pushes).toBe(2);
		expect(result.truncated).toBe(false);
	});

	it("lists only what the walk reaches past a gap, and a pin beyond it without its changes", async () => {
		const chain = [
			manifest("s1", null, { a: entry("A1") }, 100),
			manifest("s2", "s1", { a: entry("A2") }, 200),
			manifest("s3", "s2", { a: entry("A3") }, 300),
		];
		const storage = await seed(chain, ["s2"]);

		const walked = await snapshots(storage);
		expect(walked.truncated).toBe(true);
		expect(walked.snapshots.map((s) => [s.id, s.restorable])).toEqual([
			["s3", true],
		]);

		await pinSnapshot(storage, key, chain[0] as Manifest, "first");
		const { snapshots: rows } = await snapshots(storage, HORIZON);
		expect(
			rows.map((s) => [s.id, s.restorable, s.files !== null, s.keptUntil]),
		).toEqual([
			["s3", true, true, expect.any(Number)],
			["s1", true, false, null],
		]);
		expect(rows[1]?.pinned).toBe(true);
		expect(rows[1]?.label).toBe("first");
		// Off the walk only its device's clock dates it.
		expect([rows[1]?.at, rows[1]?.pushes, rows[1]?.res]).toEqual([
			100,
			1,
			null,
		]);
	});

	it("marks nothing restorable by replay while HEAD's record is missing", async () => {
		const storage = await seed(
			[
				manifest("s1", null, { a: entry("A1") }, 100),
				manifest("s2", "s1", { a: entry("A2") }, 200),
				manifest("s3", "s2", { a: entry("A3") }, 300),
			],
			["s3"],
		);

		const result = await snapshots(storage);
		expect(result.lagging).toBe(true);
		expect(
			result.snapshots.map((s) => [s.id, s.restorable, s.files !== null]),
		).toEqual([
			["s2", false, true],
			["s1", false, true],
		]);
	});

	it("counts a pin as restorable even when replay cannot start at HEAD", async () => {
		const chain = [
			manifest("s1", null, { a: entry("A1") }, 100),
			manifest("s2", "s1", { a: entry("A2") }, 200),
		];
		const storage = await seed(chain, ["s2"]);
		await pinSnapshot(storage, key, chain[0] as Manifest);

		const result = await snapshots(storage, HORIZON);
		const pinned = result.snapshots.find((s) => s.id === "s1");
		expect(pinned?.pinned).toBe(true);
		// Its stored manifest needs no replay.
		expect(pinned?.restorable).toBe(true);
		expect(pinned?.keptUntil).toBeNull();
	});

	it("flags a history that has not caught up with HEAD", async () => {
		const storage = await seed(
			[
				manifest("s1", null, { a: entry("A1") }, 100),
				manifest("s2", "s1", {}, 200),
			],
			["s2"],
		);

		expect((await snapshots(storage)).lagging).toBe(true);
	});

	it("marks isHead from actual remote HEAD snapshotId", async () => {
		const storage = await seed([
			manifest("s1", null, { a: entry("A1") }, 100),
			manifest("s2", "s1", { a: entry("A2") }, 200),
		]);

		const result = await snapshots(storage);
		expect(result.snapshots[0]?.id).toBe("s2");
		expect(result.snapshots[0]?.isHead).toBe(true);
		expect(result.snapshots[1]?.isHead).toBe(false);
	});

	it("no entry is HEAD while HEAD's record is missing", async () => {
		const storage = await seed(
			[
				manifest("s1", null, { a: entry("A1") }, 100),
				manifest("s2", "s1", {}, 200),
			],
			["s2"],
		);

		const result = await snapshots(storage);
		expect(result.snapshots.every((s) => !s.isHead)).toBe(true);
	});
});
