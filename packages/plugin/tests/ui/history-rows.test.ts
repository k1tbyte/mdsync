import { describe, expect, it } from "vitest";
import type { FileVersion } from "@/sync/history";
import type { EFileKind } from "@/sync/types";
import { buildHistoryRows } from "@/ui/source-control/history-rows";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const KIND = "vault" as EFileKind;

function version(overrides: Partial<FileVersion> = {}): FileVersion {
	return {
		snapshotId: "s1",
		hash: "H1",
		size: 1024,
		mtime: 1,
		kind: KIND,
		createdAt: NOW - DAY,
		deviceId: "device-abcdef123456",
		pinned: false,
		...overrides,
	};
}

describe("buildHistoryRows", () => {
	it("titles a row by relative age and keeps the exact time in the tooltip", () => {
		const [row] = buildHistoryRows([version()], { now: NOW });
		expect(row?.title).toBe("1 day ago");
		expect(row?.isLatest).toBe(true);
		expect(row?.tooltip).toBe(new Date(NOW - DAY).toLocaleString());
	});

	it("measures the size against the next older version", () => {
		const rows = buildHistoryRows(
			[
				version({ snapshotId: "s2", hash: "H2", size: 2048, createdAt: NOW }),
				version({ size: 1024 }),
			],
			{ now: NOW },
		);
		expect(rows[0]?.size).toBe(2048);
		expect(rows[0]?.sizeDelta).toBe(1024);
		// The oldest has nothing to compare against.
		expect(rows[1]?.sizeDelta).toBeUndefined();
	});

	it("points each row at the next older version for compare-with-previous", () => {
		const rows = buildHistoryRows(
			[
				version({ snapshotId: "s2", hash: "H2", createdAt: NOW }),
				version({ hash: "H1" }),
			],
			{ now: NOW },
		);
		expect(rows[0]?.previous?.hash).toBe("H1");
		expect(rows[1]?.previous).toBeUndefined();
	});

	it("prefers a pin's name over the timestamp, but keeps both apart", () => {
		const [row] = buildHistoryRows(
			[version({ pinned: true, label: "  before the rewrite  " })],
			{ now: NOW },
		);
		expect(row?.title).toBe("before the rewrite");
		expect(row?.label).toBe("before the rewrite");
		// The diff pane still names the version by age, not by the pin.
		expect(row?.version.label).toBe("1 day ago");
	});

	it("falls back to the timestamp when a pin has no name", () => {
		const [row] = buildHistoryRows([version({ pinned: true })], { now: NOW });
		expect(row?.title).toBe("1 day ago");
		expect(row?.label).toBe("");
	});

	it("has nothing to build from an empty list", () => {
		expect(buildHistoryRows([])).toEqual([]);
	});

	it("treats a whitespace-only pin name as no name at all", () => {
		const [row] = buildHistoryRows([version({ pinned: true, label: "   " })], {
			now: NOW,
		});
		expect(row?.title).toBe("1 day ago");
		expect(row?.label).toBe("");
	});

	it("marks only the first row as the latest", () => {
		const rows = buildHistoryRows(
			[version({ snapshotId: "s2", createdAt: NOW }), version()],
			{ now: NOW },
		);
		expect(rows.map((r) => r.isLatest)).toEqual([true, false]);
	});

	it("names this device instead of showing a raw id", () => {
		const [row] = buildHistoryRows([version()], {
			now: NOW,
			currentDevice: { id: "device-abcdef123456", name: "Laptop" },
		});
		expect(row?.meta).toBe("Laptop");
	});
});
