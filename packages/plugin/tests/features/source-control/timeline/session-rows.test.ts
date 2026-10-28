import { describe, expect, it } from "vitest";
import { formatDay } from "@/core/shared";
import {
	buildSessionRows,
	touches,
} from "@/features/source-control/timeline/session-rows";
import { buildTimelineRows } from "@/features/source-control/timeline/timeline-rows";
import type { SnapshotChanges, SnapshotSummary } from "@/features/sync";
import type { EFileKind, ManifestEntry } from "@/features/sync/types";

const NOW = new Date(2026, 9, 28, 18, 0).getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ME = { id: "laptop", name: "Laptop" };

function entry(hash: string, size: number): ManifestEntry {
	return { hash, size, mtime: 1, kind: "vault" as EFileKind };
}

function changes(overrides: Partial<SnapshotChanges> = {}): SnapshotChanges {
	return { added: {}, modified: {}, deleted: {}, ...overrides };
}

let id = 0;
function version(
	at: number,
	overrides: Partial<SnapshotSummary> = {},
): SnapshotSummary {
	return {
		id: `s${++id}`,
		createdAt: at,
		deviceId: "phone",
		deviceName: "Phone",
		pinned: false,
		files: changes(),
		keptUntil: null,
		restorable: true,
		isHead: false,
		at,
		firstAt: at,
		pushes: 1,
		res: "push",
		...overrides,
	};
}

describe("buildSessionRows", () => {
	it("sums a sitting of pushes: files composed, net size, the head", () => {
		const [row] = buildSessionRows(
			[
				version(NOW - 2 * HOUR, {
					isHead: true,
					files: changes({
						modified: {
							"a.md": { from: entry("A1", 10), to: entry("A2", 30) },
						},
					}),
				}),
				version(NOW - 2 * HOUR - 5 * MINUTE, {
					files: changes({
						added: { "a.md": entry("A1", 10), "b.md": entry("B1", 5) },
					}),
				}),
			],
			{ now: NOW, currentDevice: ME },
		);
		expect(row).toMatchObject({
			meta: "2 pushes · 2 files",
			everyPush: true,
			isHead: true,
			tally: [["add", 2]],
			netDelta: 35,
		});
		expect(row?.title.startsWith("Phone · ")).toBe(true);
		expect(row?.files?.map((file) => file.path)).toEqual(["a.md", "b.md"]);
	});

	it("counts versions where history keeps one per period", () => {
		const [row] = buildSessionRows(
			[
				version(NOW - 5 * HOUR, {
					res: "1h",
					pushes: 3,
					firstAt: NOW - 5 * HOUR - 40 * MINUTE,
				}),
				version(NOW - 6 * HOUR, { res: "1h", pushes: 4 }),
			],
			{ now: NOW, currentDevice: ME },
		);
		// A picked day matches the session from its first push, not only its last.
		expect(row).toMatchObject({
			meta: "2 versions · 7 pushes · 0 files",
			everyPush: false,
			firstAt: NOW - 6 * HOUR,
		});
		expect(row?.versions.map((item) => item.meta)).toEqual([
			"last of 3 pushes",
			"last of 4 pushes",
		]);
	});

	it("names a pin by its label and dates it, as it sits apart from its day", () => {
		const at = NOW - 3 * HOUR;
		const [row] = buildSessionRows(
			[version(at, { pinned: true, label: "Release 1.4", files: null })],
			{ now: NOW, currentDevice: ME },
		);
		expect(row).toMatchObject({
			title: "Release 1.4",
			meta: `${formatDay(at, NOW)} · Phone`,
			tally: null,
			pinned: true,
		});
	});

	it("names this device as it is called here", () => {
		const [row] = buildSessionRows(
			[version(NOW - HOUR, { deviceId: "laptop" })],
			{
				now: NOW,
				currentDevice: ME,
			},
		);
		expect(row?.title.startsWith("Laptop · ")).toBe(true);
	});
});

describe("touches", () => {
	it("finds a path part in any kind of change, ignoring case in the path", () => {
		const [row] = buildTimelineRows(
			[
				version(NOW, {
					files: changes({
						added: { "Projects/Alpha/Brief.md": entry("A", 1) },
						deleted: { "Inbox/Draft.md": entry("D", 1) },
					}),
				}),
			],
			NOW,
		);
		if (!row) throw new Error("no row");
		expect(touches(row, "alpha/")).toBe(true);
		expect(touches(row, "draft")).toBe(true);
		expect(touches(row, "beta")).toBe(false);
	});
});
