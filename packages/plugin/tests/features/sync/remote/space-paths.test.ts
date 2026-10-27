import { describe, expect, it } from "vitest";
import type {
	HistoryLog,
	SnapshotChanges,
} from "@/features/sync/history/types";
import {
	changesToSpace,
	changesToVault,
	historyLogToVault,
	manifestToSpace,
	manifestToVault,
} from "@/features/sync/remote/space-paths";
import type { EFileKind, Manifest, ManifestEntry } from "@/features/sync/types";

function entry(hash: string, size = 1, mtime = 1): ManifestEntry {
	return { hash, size, mtime, kind: "vault" as EFileKind };
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
		folders: ["Shared/p/sub"],
	};
}

describe("manifestToSpace / manifestToVault", () => {
	it("round-trips through space and back", () => {
		const m = manifest({ "Shared/p/a.md": entry("A") });
		const spaced = manifestToSpace(m, "Shared/p");
		expect(Object.keys(spaced.files)).toEqual(["a.md"]);
		expect(spaced.folders).toEqual(["sub"]);
		const back = manifestToVault(spaced, "Shared/p");
		expect(Object.keys(back.files)).toEqual(["Shared/p/a.md"]);
		expect(back.folders).toEqual(["Shared/p/sub"]);
	});

	it('returns the same object for root ""', () => {
		const m = manifest({ "a.md": entry("A") });
		expect(manifestToSpace(m, "")).toBe(m);
		expect(manifestToVault(m, "")).toBe(m);
	});

	it("throws when a path is outside the root", () => {
		const m = manifest({ "Other/b.md": entry("B") });
		expect(() => manifestToSpace(m, "Shared/p")).toThrow("outside the space");
	});
});

describe("changesToSpace / changesToVault", () => {
	const changes: SnapshotChanges = {
		added: { "Shared/p/new.md": entry("N") },
		modified: {
			"Shared/p/edit.md": { from: entry("E1"), to: entry("E2") },
		},
		deleted: { "Shared/p/gone.md": entry("G1") },
		deletedLast: { "Shared/p/gone.md": entry("G2") },
	};

	it("translates change keys to root-relative", () => {
		const spaced = changesToSpace(changes, "Shared/p");
		expect(Object.keys(spaced.added)).toEqual(["new.md"]);
		expect(Object.keys(spaced.modified)).toEqual(["edit.md"]);
		expect(Object.keys(spaced.deleted)).toEqual(["gone.md"]);
		expect(spaced.modified["edit.md"]).toEqual({
			from: entry("E1"),
			to: entry("E2"),
		});
	});

	it("rekeys deletedLast with the rest", () => {
		const spaced = changesToSpace(changes, "Shared/p");
		expect(spaced.deletedLast).toEqual({ "gone.md": entry("G2") });
		expect(changesToVault(spaced, "Shared/p").deletedLast).toEqual({
			"Shared/p/gone.md": entry("G2"),
		});
	});

	it("adds no deletedLast to a record that had none", () => {
		const { deletedLast: _, ...plain } = changes;
		expect(changesToSpace(plain, "Shared/p")).not.toHaveProperty("deletedLast");
		expect(changesToVault(plain, "Shared/p")).not.toHaveProperty("deletedLast");
	});

	it("round-trips back to vault paths", () => {
		const back = changesToVault(
			changesToSpace(changes, "Shared/p"),
			"Shared/p",
		);
		expect(back).toEqual(changes);
	});

	it('returns the same object for root ""', () => {
		expect(changesToSpace(changes, "")).toBe(changes);
		expect(changesToVault(changes, "")).toBe(changes);
	});

	it("throws when a path is outside the root, deletedLast included", () => {
		expect(() => changesToSpace(changes, "Other")).toThrow("outside the space");
		const stray: SnapshotChanges = {
			added: {},
			modified: {},
			deleted: {},
			deletedLast: { "Other/x.md": entry("X") },
		};
		expect(() => changesToSpace(stray, "Shared/p")).toThrow(
			"outside the space",
		);
	});
});

describe("historyLogToVault", () => {
	const log: HistoryLog = {
		version: 2,
		snapshots: [{ id: "s1", parentId: null, createdAt: 1, deviceId: "d" }],
		changes: {
			s1: {
				added: { "new.md": entry("N") },
				modified: {},
				deleted: { "gone.md": entry("G1") },
				deletedLast: { "gone.md": entry("G2") },
			},
		},
	};

	it("translates every record's keys to vault paths", () => {
		const back = historyLogToVault(log, "Shared/p");
		expect(Object.keys(back.changes.s1?.added ?? {})).toEqual([
			"Shared/p/new.md",
		]);
		expect(Object.keys(back.changes.s1?.deleted ?? {})).toEqual([
			"Shared/p/gone.md",
		]);
		expect(Object.keys(back.changes.s1?.deletedLast ?? {})).toEqual([
			"Shared/p/gone.md",
		]);
		expect(back.snapshots).toBe(log.snapshots);
	});

	it('returns the same object for root ""', () => {
		expect(historyLogToVault(log, "")).toBe(log);
	});
});
