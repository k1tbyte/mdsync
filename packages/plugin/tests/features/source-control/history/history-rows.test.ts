import { describe, expect, it } from "vitest";
import { formatDay } from "@/core/shared";
import {
	ageTitle,
	clockTime,
} from "@/features/source-control/history/age-groups";
import { buildHistoryRows } from "@/features/source-control/history/history-rows";
import type { FileVersion } from "@/features/sync/history/types";
import type { EFileKind } from "@/features/sync/types";

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
		pinId: null,
		first: false,
		replayable: true,
		at: NOW - DAY,
		firstAt: NOW - DAY,
		pushes: 1,
		res: "push",
		...overrides,
	};
}

describe("buildHistoryRows", () => {
	it("titles a row from an older day by its clock time and keeps the exact time in the tooltip", () => {
		const [row] = buildHistoryRows([version()], { now: NOW });
		expect(row?.title).toBe(
			new Date(NOW - DAY).toLocaleTimeString(undefined, {
				hour: "2-digit",
				minute: "2-digit",
			}),
		);
		expect(row?.isLatest).toBe(true);
		expect(row?.tooltip).toBe(new Date(NOW - DAY).toLocaleString());
	});

	it("titles a row by storage time, as finely as it is kept", () => {
		const at = NOW - 60_000;
		const rows = buildHistoryRows(
			[
				version({ createdAt: NOW - DAY, at, res: "push" }),
				version({ createdAt: at, at, res: "1d" }),
			],
			{ now: NOW },
		);
		expect(rows.map((row) => row.title)).toEqual([
			ageTitle({ at, res: "push" }, NOW),
			ageTitle({ at, res: "1d" }, NOW),
		]);
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
			[version({ pinId: "p1", label: "  before the rewrite  " })],
			{ now: NOW },
		);
		expect(row?.title).toBe("before the rewrite");
		expect(row?.label).toBe("before the rewrite");
		// Pins sit apart from their day, so the meta carries it.
		expect(row?.meta).toBe(`${formatDay(NOW - DAY, NOW)} · Device device-a`);
		// The diff pane still names the version by age, not by the pin.
		expect(row?.version.label).toBe("1 day ago");
	});

	it("falls back to the timestamp when a pin has no name", () => {
		const [row] = buildHistoryRows([version({ pinId: "p1" })], { now: NOW });
		expect(row?.title).toBe(clockTime(NOW - DAY));
		expect(row?.label).toBe("");
	});

	it("has nothing to build from an empty list", () => {
		expect(buildHistoryRows([])).toEqual([]);
	});

	it("treats a whitespace-only pin name as no name at all", () => {
		const [row] = buildHistoryRows([version({ pinId: "p1", label: "   " })], {
			now: NOW,
		});
		expect(row?.title).toBe(clockTime(NOW - DAY));
		expect(row?.label).toBe("");
	});

	it("marks only the first row as the latest", () => {
		const rows = buildHistoryRows(
			[version({ snapshotId: "s2", createdAt: NOW }), version()],
			{ now: NOW },
		);
		expect(rows.map((r) => r.isLatest)).toEqual([true, false]);
	});

	it("says how many pushes a version stands for, and which one created the file", () => {
		const rows = buildHistoryRows(
			[version({ pushes: 3, res: "10m" }), version({ first: true })],
			{ now: NOW },
		);
		expect(rows.map((row) => row.meta)).toEqual([
			"Device device-a · last of 3 pushes",
			"Device device-a · first version",
		]);
	});

	it("names this device instead of showing a raw id", () => {
		const [row] = buildHistoryRows([version()], {
			now: NOW,
			currentDevice: { id: "device-abcdef123456", name: "Laptop" },
		});
		expect(row?.meta).toBe("Laptop");
	});
});
