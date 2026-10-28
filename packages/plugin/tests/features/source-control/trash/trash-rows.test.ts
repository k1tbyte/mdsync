import { describe, expect, it } from "vitest";
import { formatDay, formatRelativeTime } from "@/core/shared/format";
import {
	buildTrashRows,
	resolveRestoreTarget,
	retentionText,
} from "@/features/source-control/trash/trash-rows";
import type { DeletedFile } from "@/features/sync/history/types";
import type { EFileKind } from "@/features/sync/types";

const NOW = 1_700_000_000_000;
const KIND = "vault" as EFileKind;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const KEPT_UNTIL = NOW + 30 * DAY;

function deleted(overrides: Partial<DeletedFile> = {}): DeletedFile {
	return {
		path: "notes/gone.md",
		entry: { hash: "H1", size: 2048, mtime: 1, kind: KIND },
		snapshotId: "s2",
		source: "deleted",
		createdAt: NOW - 3 * DAY,
		deviceId: "device-abcdef123456",
		pinned: false,
		keptUntil: KEPT_UNTIL,
		...overrides,
	};
}

describe("formatRelativeTime", () => {
	it("reads in the largest unit that still has a whole count", () => {
		expect(formatRelativeTime(NOW - 30_000, NOW)).toBe("just now");
		expect(formatRelativeTime(NOW - 60_000, NOW)).toBe("1 minute ago");
		expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toBe("5 minutes ago");
		expect(formatRelativeTime(NOW - HOUR, NOW)).toBe("1 hour ago");
		expect(formatRelativeTime(NOW - 3 * DAY, NOW)).toBe("3 days ago");
	});

	it("switches to a date once the distance stops being useful", () => {
		const old = formatRelativeTime(NOW - 60 * DAY, NOW);
		expect(old).not.toContain("ago");
		expect(old).toBe(formatDay(NOW - 60 * DAY, NOW, false));
	});

	it("treats a clock-skewed future stamp as now, not as negative time", () => {
		expect(formatRelativeTime(NOW + DAY, NOW)).toBe("just now");
	});
});

describe("retentionText", () => {
	it("names the date history keeps the record until", () => {
		expect(retentionText({ pinned: false, keptUntil: KEPT_UNTIL }, NOW)).toBe(
			`Kept until ${formatDay(KEPT_UNTIL, NOW, false)}`,
		);
	});

	it("still names a date that has passed while cleanup has not caught up", () => {
		// Retention promises "at least": a record can outlive its date and still be listed.
		const past = NOW - DAY;
		expect(retentionText({ pinned: false, keptUntil: past }, NOW)).toBe(
			`Kept until ${formatDay(past, NOW, false)}`,
		);
	});

	it("says nothing when no date applies", () => {
		expect(retentionText({ pinned: false, keptUntil: null }, NOW)).toBeNull();
	});

	it("says a pin holds the record", () => {
		expect(retentionText({ pinned: true, keptUntil: null }, NOW)).toBe(
			"Kept by a pinned snapshot",
		);
	});

	it("lets a pin win over a date", () => {
		expect(retentionText({ pinned: true, keptUntil: KEPT_UNTIL }, NOW)).toBe(
			"Kept by a pinned snapshot",
		);
	});
});

describe("buildTrashRows", () => {
	it("describes a deletion with time, device and size", () => {
		const [row] = buildTrashRows([deleted()], {
			now: NOW,
			currentDevice: null,
		});

		expect(row?.title).toBe("notes/gone.md");
		expect(row?.hash).toBe("H1");
		expect(row?.meta).toBe("deleted 3 days ago · Device device-a · 2.0 KB");
		expect(row?.note).toEqual({
			text: `Kept until ${formatDay(KEPT_UNTIL, NOW, false)}`,
			tone: "plain",
			icon: "hourglass",
		});
		expect(row?.pinned).toBe(false);
	});

	it("has nothing to build from an empty list", () => {
		expect(buildTrashRows([], {})).toEqual([]);
	});

	it("colours a record whose retention ends within a week or already has", () => {
		const rows = buildTrashRows(
			[
				deleted({ keptUntil: NOW - DAY }),
				deleted({ keptUntil: NOW + 6 * DAY }),
				deleted({ keptUntil: NOW + 7 * DAY }),
				deleted({ keptUntil: NOW + 8 * DAY }),
			],
			{ now: NOW },
		);
		expect(rows.map((row) => row.note?.tone)).toEqual([
			"soon",
			"soon",
			"soon",
			"plain",
		]);
	});

	it("leaves a deletion with no end date without a note", () => {
		const [row] = buildTrashRows([deleted({ keptUntil: null })], {
			now: NOW,
		});
		expect(row?.note).toBeNull();
		expect(row?.pinned).toBe(false);
	});

	it("marks a file that is back in the vault as restored", () => {
		const rows = buildTrashRows(
			[deleted(), deleted({ path: "notes/other.md" })],
			{
				now: NOW,
				inVault: (path) => path === "notes/gone.md",
			},
		);
		expect(rows.map((row) => row.note?.tone)).toEqual(["restored", "plain"]);
	});

	it("treats every file as still deleted without a vault to ask", () => {
		const [row] = buildTrashRows([deleted()], { now: NOW });
		expect(row?.note?.tone).toBe("plain");
	});

	it("dates against the wall clock when no time is supplied", () => {
		const [row] = buildTrashRows([deleted({ createdAt: Date.now() })], {});
		expect(row?.meta).toContain("deleted just now");
	});

	it("reports an empty file without collapsing its size", () => {
		const [row] = buildTrashRows(
			[deleted({ entry: { hash: "E", size: 0, mtime: 1, kind: KIND } })],
			{ now: NOW },
		);
		expect(row?.meta).toContain("0 B");
		expect(row?.size).toBe(0);
	});

	it("names this device instead of showing a raw id", () => {
		const [row] = buildTrashRows([deleted()], {
			now: NOW,
			currentDevice: { id: "device-abcdef123456", name: "Laptop" },
		});
		expect(row?.meta).toContain("Laptop");
	});

	it("prefers the recorded device name over the id", () => {
		const [row] = buildTrashRows([deleted({ deviceName: "Phone" })], {
			now: NOW,
		});
		expect(row?.meta).toContain("Phone");
	});

	it("keeps a bare age apart from the prefixed label", () => {
		const [row] = buildTrashRows([deleted()], { now: NOW });
		expect(row?.age).toBe("3 days ago");
		expect(row?.label).toBe("deleted 3 days ago");
	});

	it("names the pin a file was last seen in", () => {
		const [row] = buildTrashRows(
			[
				deleted({
					source: "pinned",
					pinned: true,
					keptUntil: null,
					label: "before the rewrite",
				}),
			],
			{ now: NOW },
		);
		expect(row?.label).toBe('last seen in "before the rewrite"');
	});

	it("marks a deletion a pin also holds as pinned, whatever the source says", () => {
		const [row] = buildTrashRows([deleted({ pinned: true, keptUntil: null })], {
			now: NOW,
		});
		expect(row?.pinned).toBe(true);
		expect(row?.note?.text).toBe("Kept by a pinned snapshot");
		expect(row?.note?.tone).toBe("pinned");
	});

	it("keeps a pinned note from turning into a countdown", () => {
		const [row] = buildTrashRows(
			[deleted({ pinned: true, keptUntil: NOW + DAY })],
			{ now: NOW },
		);
		expect(row?.note?.tone).toBe("pinned");
	});

	it("says last seen, not deleted, for a file only a pin still holds", () => {
		const [row] = buildTrashRows(
			[deleted({ source: "pinned", pinned: true, keptUntil: null })],
			{ now: NOW },
		);
		expect(row?.meta).toContain("last seen 3 days ago");
		expect(row?.pinned).toBe(true);
		expect(row?.note?.text).toBe("Kept by a pinned snapshot");
		expect(row?.note?.tone).toBe("pinned");
	});
});

describe("resolveRestoreTarget", () => {
	it("normalises separators and a leading slash", () => {
		expect(resolveRestoreTarget(String.raw`  \notes\a.md `)).toBe("notes/a.md");
	});

	it("rejects anything that cannot name a file in this vault", () => {
		expect(resolveRestoreTarget("")).toBeNull();
		expect(resolveRestoreTarget("   ")).toBeNull();
		// Escapes the vault root.
		expect(resolveRestoreTarget("../outside.md")).toBeNull();
		expect(resolveRestoreTarget("notes/../../outside.md")).toBeNull();
		// Names a folder, not a file.
		expect(resolveRestoreTarget("notes/")).toBeNull();
		expect(resolveRestoreTarget(".")).toBeNull();
		expect(resolveRestoreTarget("notes/./a.md")).toBeNull();
		expect(resolveRestoreTarget("notes//a.md")).toBeNull();
	});

	it("keeps a dot that is not a traversal segment", () => {
		expect(resolveRestoreTarget("notes/..hidden.md")).toBe("notes/..hidden.md");
	});
});
