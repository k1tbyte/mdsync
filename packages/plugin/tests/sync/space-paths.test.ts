import { describe, expect, it } from "vitest";
import type { HistoryLog, SnapshotChanges } from "@/sync/history/types";
import {
	historyLogToSpace,
	historyLogToVault,
	manifestToSpace,
	manifestToVault,
} from "@/sync/space-paths";
import type { EFileKind, Manifest, ManifestEntry } from "@/sync/types";

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

describe("historyLogToSpace / historyLogToVault", () => {
	const changes: SnapshotChanges = {
		added: { "Shared/p/new.md": entry("N") },
		modified: {
			"Shared/p/edit.md": { from: entry("E1"), to: entry("E2") },
		},
		deleted: { "Shared/p/gone.md": entry("G") },
	};
	const log: HistoryLog = {
		version: 2,
		snapshots: [{ id: "s1", parentId: null, createdAt: 1, deviceId: "d" }],
		changes: { s1: changes },
	};

	it("translates change keys to root-relative", () => {
		const spaced = historyLogToSpace(log, "Shared/p");
		const sc = spaced.changes.s1 as SnapshotChanges;
		expect(Object.keys(sc.added)).toEqual(["new.md"]);
		expect(Object.keys(sc.modified)).toEqual(["edit.md"]);
		expect(Object.keys(sc.deleted)).toEqual(["gone.md"]);
	});

	it("round-trips back to vault paths", () => {
		const spaced = historyLogToSpace(log, "Shared/p");
		const back = historyLogToVault(spaced, "Shared/p");
		expect(Object.keys(back.changes.s1?.added ?? {})).toEqual([
			"Shared/p/new.md",
		]);
	});

	it('returns the same object for root ""', () => {
		expect(historyLogToSpace(log, "")).toBe(log);
		expect(historyLogToVault(log, "")).toBe(log);
	});
});
