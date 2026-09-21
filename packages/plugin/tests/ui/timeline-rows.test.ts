import { describe, expect, it } from "vitest";
import type {
	SnapshotChanges,
	SnapshotSummary,
	VaultRestorePlan,
} from "@/sync/history";
import type { EFileKind, ManifestEntry } from "@/sync/types";
import {
	buildTimelineRows,
	countsText,
	describeRestorePlan,
	samplePaths,
	type TimelineFileRow,
	timelineDiffTarget,
} from "@/ui/source-control/timeline-rows";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function entry(hash: string, size = 1, mtime = 1): ManifestEntry {
	return { hash, size, mtime, kind: "vault" as EFileKind };
}

function changes(overrides: Partial<SnapshotChanges> = {}): SnapshotChanges {
	return {
		added: {},
		modified: {},
		deleted: {},
		...overrides,
	};
}

function snapshot(overrides: Partial<SnapshotSummary> = {}): SnapshotSummary {
	return {
		id: "s1",
		createdAt: NOW - DAY,
		deviceId: "device-abcdef123456",
		pinned: false,
		files: changes({ added: { "a.md": entry("A1", 10) } }),
		rank: 0,
		restorable: true,
		isHead: false,
		...overrides,
	};
}

function plan(overrides: Partial<VaultRestorePlan> = {}): VaultRestorePlan {
	return { write: [], remove: [], unchanged: 0, ignored: [], ...overrides };
}

describe("countsText", () => {
	it("names only the parts that actually changed", () => {
		expect(
			countsText(
				snapshot({
					files: changes({
						added: { a: entry("A1") },
						modified: {
							b: { from: entry("B1"), to: entry("B2") },
							c: { from: entry("C1"), to: entry("C2") },
						},
					}),
				}),
			),
		).toBe("+1 new · 2 changed");
	});

	it("says so when a push changed no files", () => {
		expect(countsText(snapshot({ files: changes() }))).toBe("no file changes");
	});

	it("stays null when no record explains the snapshot", () => {
		expect(countsText(snapshot({ files: null }))).toBeNull();
	});

	it("works with records not arrays", () => {
		expect(
			countsText(
				snapshot({
					files: changes({
						added: { x: entry("X1"), y: entry("Y1") },
						deleted: { z: entry("Z1") },
					}),
				}),
			),
		).toBe("+2 new · 1 removed");
	});
});

describe("buildTimelineRows", () => {
	it("marks only the actual HEAD as isHead, not just index 0", () => {
		const rows = buildTimelineRows(
			[
				snapshot({ id: "s2", createdAt: NOW, isHead: true }),
				snapshot({ isHead: false }),
			],
			{ now: NOW },
		);
		expect(rows[0]?.isHead).toBe(true);
		expect(rows[1]?.isHead).toBe(false);
		expect(rows[1]?.title).toBe("1 day ago");
	});

	it("real HEAD versus lagging entry", () => {
		const rows = buildTimelineRows(
			[snapshot({ id: "old", createdAt: NOW - DAY, isHead: false })],
			{ now: NOW },
		);
		expect(rows[0]?.isHead).toBe(false);
	});

	it("prefers a pin's name over the timestamp", () => {
		const [row] = buildTimelineRows(
			[snapshot({ pinned: true, label: "  before the rewrite " })],
			{ now: NOW },
		);
		expect(row?.title).toBe("before the rewrite");
		expect(row?.pinned).toBe(true);
		expect(row?.label).toBe("before the rewrite");
	});

	it("carries restorability through untouched", () => {
		const [row] = buildTimelineRows([snapshot({ restorable: false })], {
			now: NOW,
		});
		expect(row?.restorable).toBe(false);
	});

	it("produces sorted file rows with full before/after metadata", () => {
		const [row] = buildTimelineRows(
			[
				snapshot({
					createdAt: NOW,
					files: changes({
						added: { "z-new.md": entry("N1", 50) },
						modified: {
							"a-mod.md": { from: entry("M1", 100), to: entry("M2", 200) },
						},
						deleted: { "m-gone.md": entry("G1", 30) },
					}),
				}),
			],
			{ now: NOW },
		);
		expect(row?.files).toHaveLength(3);
		const [first, second, third] = row?.files ?? [];

		// Sorted by path: a-mod < m-gone < z-new
		expect(first?.path).toBe("a-mod.md");
		expect(first?.action).toBe("modify");
		expect(first?.version.hash).toBe("M2");
		expect(first?.before?.hash).toBe("M1");
		expect(first?.before?.size).toBe(100);
		expect(first?.after?.hash).toBe("M2");
		expect(first?.after?.size).toBe(200);

		expect(second?.path).toBe("m-gone.md");
		expect(second?.action).toBe("delete");
		expect(second?.version.hash).toBe("G1");
		expect(second?.before?.hash).toBe("G1");
		expect(second?.after).toBeNull();

		expect(third?.path).toBe("z-new.md");
		expect(third?.action).toBe("add");
		expect(third?.version.hash).toBe("N1");
		expect(third?.before).toBeNull();
		expect(third?.after?.hash).toBe("N1");
	});

	it("deletion preserves pre-delete version with size", () => {
		const [row] = buildTimelineRows(
			[
				snapshot({
					createdAt: NOW,
					files: changes({
						deleted: { "gone.md": entry("DEAD", 999) },
					}),
				}),
			],
			{ now: NOW },
		);
		const file = row?.files?.[0];
		expect(file?.action).toBe("delete");
		expect(file?.version.hash).toBe("DEAD");
		expect(file?.version.size).toBe(999);
	});

	it("added empty file has zero size", () => {
		const [row] = buildTimelineRows(
			[
				snapshot({
					createdAt: NOW,
					files: changes({
						added: { "empty.md": entry("E0", 0) },
					}),
				}),
			],
			{ now: NOW },
		);
		const file = row?.files?.[0];
		expect(file?.action).toBe("add");
		expect(file?.version.size).toBe(0);
		expect(file?.after?.size).toBe(0);
	});

	it("handles path named constructor without crashing", () => {
		const [row] = buildTimelineRows(
			[
				snapshot({
					createdAt: NOW,
					files: changes({
						added: { constructor: entry("CON1", 5) },
					}),
				}),
			],
			{ now: NOW },
		);
		expect(row?.files?.[0]?.path).toBe("constructor");
	});

	it("modified both sides carry distinct hashes and sizes", () => {
		const [row] = buildTimelineRows(
			[
				snapshot({
					createdAt: NOW,
					files: changes({
						modified: {
							"doc.md": { from: entry("OLD", 100), to: entry("NEW", 250) },
						},
					}),
				}),
			],
			{ now: NOW },
		);
		const file = row?.files?.[0];
		expect(file?.before?.hash).toBe("OLD");
		expect(file?.before?.size).toBe(100);
		expect(file?.after?.hash).toBe("NEW");
		expect(file?.after?.size).toBe(250);
		expect(file?.version).toEqual(file?.after);
	});

	it("files is null when snapshot has no change record", () => {
		const [row] = buildTimelineRows([snapshot({ files: null })], { now: NOW });
		expect(row?.files).toBeNull();
	});

	it("sizes each file row, and only a modification carries a delta", () => {
		const [row] = buildTimelineRows(
			[
				snapshot({
					createdAt: NOW,
					files: changes({
						added: { "z-new.md": entry("N1", 50) },
						modified: {
							"a-mod.md": { from: entry("M1", 100), to: entry("M2", 250) },
						},
						deleted: { "m-gone.md": entry("G1", 30) },
					}),
				}),
			],
			{ now: NOW },
		);
		const [modified, deleted, added] = row?.files ?? [];
		expect(modified?.size).toBe(250);
		expect(modified?.sizeDelta).toBe(150);
		expect(deleted?.size).toBe(30);
		expect(deleted?.sizeDelta).toBeUndefined();
		expect(added?.size).toBe(50);
		expect(added?.sizeDelta).toBeUndefined();
	});

	it("nets the push down to one signed figure", () => {
		const [row] = buildTimelineRows(
			[
				snapshot({
					files: changes({
						added: { "new.md": entry("N1", 3072) },
						modified: {
							"mod.md": { from: entry("M1", 2048), to: entry("M2", 1024) },
						},
						deleted: { "gone.md": entry("G1", 1024) },
					}),
				}),
			],
			{ now: NOW },
		);
		// 3072 added, 1024 lost on the edit, 1024 removed.
		expect(row?.netSize).toBe("+1.0 KB");
	});

	it("says nothing about size when the push broke even, or is unknown", () => {
		const [even] = buildTimelineRows(
			[
				snapshot({
					files: changes({
						modified: {
							"mod.md": { from: entry("M1", 100), to: entry("M2", 100) },
						},
					}),
				}),
			],
			{ now: NOW },
		);
		expect(even?.netSize).toBeNull();
		const [unknown] = buildTimelineRows([snapshot({ files: null })], {
			now: NOW,
		});
		expect(unknown?.netSize).toBeNull();
	});
});

describe("timelineDiffTarget", () => {
	const fileRow: TimelineFileRow = {
		path: "test.md",
		action: "modify",
		version: { hash: "NEW", size: 200, label: "after push" },
		before: { hash: "OLD", size: 100, label: "before push" },
		after: { hash: "NEW", size: 200, label: "after push" },
		size: 200,
		sizeDelta: 100,
	};

	it("current mode returns version with previewIfMissing", () => {
		const target = timelineDiffTarget(fileRow, "current");
		expect(target.hash).toBe("NEW");
		expect(target.size).toBe(200);
		expect(target.previewIfMissing).toBe(true);
		expect(target.change).toBeUndefined();
	});

	it("change mode returns version with before/after change", () => {
		const target = timelineDiffTarget(fileRow, "change");
		expect(target.hash).toBe("NEW");
		expect(target.change?.before?.hash).toBe("OLD");
		expect(target.change?.after?.hash).toBe("NEW");
		expect(target.previewIfMissing).toBeUndefined();
	});

	it("defaults to current mode", () => {
		const target = timelineDiffTarget(fileRow);
		expect(target.previewIfMissing).toBe(true);
	});

	it("targets do not lose sizes", () => {
		const target = timelineDiffTarget(fileRow, "change");
		expect(target.size).toBe(200);
		expect(target.change?.before?.size).toBe(100);
		expect(target.change?.after?.size).toBe(200);
	});

	it("deleted file target has null after", () => {
		const deleted: TimelineFileRow = {
			path: "gone.md",
			action: "delete",
			version: { hash: "DEAD", size: 50, label: "before push" },
			before: { hash: "DEAD", size: 50, label: "before push" },
			after: null,
			size: 50,
		};
		const target = timelineDiffTarget(deleted, "change");
		expect(target.change?.before?.hash).toBe("DEAD");
		expect(target.change?.after).toBeNull();
	});

	it("added file target has null before", () => {
		const added: TimelineFileRow = {
			path: "new.md",
			action: "add",
			version: { hash: "FRESH", size: 10, label: "after push" },
			before: null,
			after: { hash: "FRESH", size: 10, label: "after push" },
			size: 10,
		};
		const target = timelineDiffTarget(added, "change");
		expect(target.change?.before).toBeNull();
		expect(target.change?.after?.hash).toBe("FRESH");
	});
});

describe("describeRestorePlan", () => {
	it("leads with the deletions, which are the destructive part", () => {
		const lines = describeRestorePlan(
			plan({
				remove: ["x.md", "y.md"],
				write: [
					{
						path: "a.md",
						entry: { hash: "A", size: 1, mtime: 1, kind: "vault" },
					},
				],
				unchanged: 5,
			}),
		);
		expect(lines[0]).toBe("2 files will be deleted.");
		expect(lines[1]).toBe("1 file will be written or restored.");
		expect(lines[2]).toBe("5 files already up to date.");
	});

	it("says the ignore rules win, and reads right for a single file", () => {
		expect(describeRestorePlan(plan({ ignored: ["secret.md"] }))).toContain(
			"1 file excluded by ignore rules will not be touched.",
		);
		expect(describeRestorePlan(plan({ unchanged: 1 }))).toContain(
			"1 file already up to date.",
		);
	});

	it("says nothing would happen when the plan is empty", () => {
		expect(describeRestorePlan(plan())).toEqual([
			"The vault already matches this snapshot.",
		]);
	});
});

describe("samplePaths", () => {
	it("caps the list and says how much it left out", () => {
		const lines = samplePaths(["a", "b", "c"], 2);
		expect(lines).toEqual(["• a", "• b", "• …and 1 more"]);
	});

	it("lists everything when it fits", () => {
		expect(samplePaths(["a"], 5)).toEqual(["• a"]);
		expect(samplePaths([], 5)).toEqual([]);
	});
});
