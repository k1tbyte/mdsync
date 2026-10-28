import { describe, expect, it } from "vitest";
import { sessionsOf } from "@/features/source-control/timeline/sessions";
import type { SnapshotSummary } from "@/features/sync";
import type { EFileKind, ManifestEntry } from "@/features/sync/types";

const NOW = new Date(2026, 9, 28, 18, 0).getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function entry(hash: string, size = 1): ManifestEntry {
	return { hash, size, mtime: 1, kind: "vault" as EFileKind };
}

let id = 0;
function version(
	at: number,
	overrides: Partial<SnapshotSummary> = {},
): SnapshotSummary {
	return {
		id: `s${++id}`,
		createdAt: at,
		deviceId: "laptop",
		pinned: false,
		files: { added: {}, modified: {}, deleted: {} },
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

const sizes = (list: ReturnType<typeof sessionsOf>) =>
	list.map((session) => session.versions.length);

describe("sessionsOf", () => {
	it("joins one device's pushes close together, newest first", () => {
		const list = sessionsOf(
			[
				version(NOW - 2 * HOUR),
				version(NOW - 2 * HOUR - 5 * MINUTE),
				version(NOW - 2 * HOUR - 9 * MINUTE),
				version(NOW - 3 * HOUR),
			],
			NOW,
		);
		expect(sizes(list)).toEqual([3, 1]);
		expect(list[0]).toMatchObject({
			at: NOW - 2 * HOUR,
			firstAt: NOW - 2 * HOUR - 9 * MINUTE,
			pushes: 3,
		});
	});

	it("splits at another device, a resolution, a pin and a heading", () => {
		expect(
			sizes(
				sessionsOf(
					[
						version(NOW - 3 * HOUR),
						version(NOW - 3 * HOUR - MINUTE, { deviceId: "phone" }),
						version(NOW - 3 * HOUR - 2 * MINUTE, {
							deviceId: "phone",
							res: "10m",
						}),
						version(NOW - 3 * HOUR - 3 * MINUTE, { res: "10m" }),
						version(NOW - 3 * HOUR - 4 * MINUTE, { res: "10m", pinned: true }),
						version(NOW - 3 * HOUR - 5 * MINUTE, { res: "10m" }),
					],
					NOW,
				),
			),
		).toEqual([1, 1, 1, 1, 1, 1]);
		// 17:05 is the last hour, 16:58 today: one sitting, two headings.
		expect(
			sizes(
				sessionsOf(
					[version(NOW - 55 * MINUTE), version(NOW - 62 * MINUTE)],
					NOW,
				),
			),
		).toEqual([1, 1]);
	});

	it("lets packed versions sit one period apart", () => {
		const hourly = (hours: number) =>
			version(NOW - hours * HOUR, {
				res: "1h",
				firstAt: NOW - hours * HOUR - 40 * MINUTE,
			});
		expect(sizes(sessionsOf([hourly(5), hourly(6), hourly(9)], NOW))).toEqual([
			2, 1,
		]);
	});

	it("composes the session's changes from its oldest parent", () => {
		const [session] = sessionsOf(
			[
				version(NOW - 2 * HOUR, {
					pushes: 2,
					files: {
						added: {},
						modified: { "a.md": { from: entry("A1", 5), to: entry("A2", 9) } },
						deleted: { "b.md": entry("B1") },
					},
				}),
				version(NOW - 2 * HOUR - MINUTE, {
					files: {
						added: { "a.md": entry("A1", 5) },
						modified: {},
						deleted: {},
					},
				}),
			],
			NOW,
		);
		expect(session?.pushes).toBe(3);
		expect(session?.changes).toEqual({
			added: { "a.md": entry("A2", 9) },
			modified: {},
			deleted: { "b.md": entry("B1") },
		});
	});

	it("knows nothing of a session with a version no record explains", () => {
		const [session] = sessionsOf(
			[
				version(NOW - 2 * HOUR, { files: null }),
				version(NOW - 2 * HOUR - MINUTE),
			],
			NOW,
		);
		expect(session?.changes).toBeNull();
	});
});
