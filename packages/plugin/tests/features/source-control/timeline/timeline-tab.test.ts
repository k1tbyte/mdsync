// @vitest-environment jsdom

import { installElementMethods } from "@tests/helpers/element-methods";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceControlHost } from "@/features/source-control/host";
import { renderSessionCard } from "@/features/source-control/timeline/session-card";
import type { SessionRow } from "@/features/source-control/timeline/session-rows";
import { TimelineTab } from "@/features/source-control/timeline/timeline-tab";
import type { SnapshotListResult, SnapshotSummary } from "@/features/sync";
import type { EFileKind, ManifestEntry } from "@/features/sync/types";

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<object>()),
	SearchComponent: class {
		inputEl = document.createElement("input");
		setPlaceholder() {
			return this;
		}
		setValue() {
			return this;
		}
		onChange() {
			return this;
		}
	},
}));
vi.mock("@/features/source-control/timeline/session-card", () => ({
	renderSessionCard: vi.fn(),
}));

installElementMethods();

const NOW = new Date(2026, 9, 28, 18, 0).getTime();
const MINUTE = 60_000;
const ME = { id: "laptop", name: "Laptop" };

function entry(hash: string): ManifestEntry {
	return { hash, size: 1, mtime: 1, kind: "vault" as EFileKind };
}

function version(id: string, at: number, path: string): SnapshotSummary {
	return {
		id,
		createdAt: at,
		deviceId: "laptop",
		pinned: false,
		files: { added: { [path]: entry(id) }, modified: {}, deleted: {} },
		keptUntil: null,
		restorable: true,
		isHead: false,
		at,
		firstAt: at,
		pushes: 1,
		res: "push",
	};
}

/** Two close pushes of one device: one session, whose changes are composed. */
function loaded(): SnapshotListResult {
	return {
		snapshots: [
			version("s2", NOW - 20 * MINUTE, "b.md"),
			version("s1", NOW - 25 * MINUTE, "a.md"),
		],
		lagging: false,
		truncated: false,
		activity: {},
	};
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(results: SnapshotListResult[]) {
	const listSnapshots = vi.fn(
		async () => results.shift() as SnapshotListResult,
	);
	const plugin = {
		app: {},
		settings: { fileHistoryEnabled: true, fileHistoryActivity: false },
		controller: {
			history: { listSnapshots },
			currentDevice: () => ME,
		},
	} as unknown as SourceControlHost;
	let tab!: TimelineTab;
	const draw = () => {
		const parent = document.createElement("div");
		tab.render(parent, document.createElement("div"));
	};
	tab = new TimelineTab(plugin, draw, vi.fn(), vi.fn());
	return { tab, draw, listSnapshots };
}

/** The session rows the last render handed to the cards, and the card context. */
function lastDrawn() {
	const calls = vi.mocked(renderSessionCard).mock.calls;
	const rows: SessionRow[] = calls.map(([, row]) => row);
	return { rows, ctx: calls[calls.length - 1]?.[2] };
}

describe("TimelineTab session rows", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
		vi.mocked(renderSessionCard).mockClear();
	});
	afterEach(() => vi.useRealTimers());

	it("keeps the composed changes across UI-only rerenders of one result", async () => {
		const { draw, listSnapshots } = harness([loaded()]);
		draw();
		await settled();
		const [first] = lastDrawn().rows;
		expect(first?.versions).toHaveLength(2);
		// File rows are cached by the composed changes object, so the same array means the same changes.
		const files = first?.files;
		expect(files?.map((file) => file.path)).toEqual(["a.md", "b.md"]);

		// Expanding a card redraws the pane without loading anything.
		const { ctx } = lastDrawn();
		vi.mocked(renderSessionCard).mockClear();
		ctx?.toggle(first?.key ?? "");
		draw();

		const [expanded, again] = lastDrawn().rows;
		expect(vi.mocked(renderSessionCard)).toHaveBeenCalledTimes(2);
		expect(expanded).toBe(first);
		expect(again).toBe(first);
		expect(again?.files).toBe(files);
		expect(listSnapshots).toHaveBeenCalledTimes(1);
	});

	it("builds new rows once a new result loads", async () => {
		const { tab, draw, listSnapshots } = harness([loaded(), loaded()]);
		draw();
		await settled();
		draw();
		const [first] = lastDrawn().rows;
		const files = first?.files;

		tab.clear();
		draw();
		await settled();
		vi.mocked(renderSessionCard).mockClear();
		draw();

		const [next] = lastDrawn().rows;
		expect(listSnapshots).toHaveBeenCalledTimes(2);
		expect(next).not.toBe(first);
		expect(next?.files).not.toBe(files);
		expect(next?.files?.map((file) => file.path)).toEqual(["a.md", "b.md"]);
	});

	it("rebuilds when the clock moves to another minute", async () => {
		const { draw } = harness([loaded()]);
		draw();
		await settled();
		draw();
		const [first] = lastDrawn().rows;

		vi.setSystemTime(NOW + MINUTE);
		vi.mocked(renderSessionCard).mockClear();
		draw();

		expect(lastDrawn().rows[0]).not.toBe(first);
	});

	it("rebuilds when a push leaves the last hour within a minute", async () => {
		const at = NOW + 30_000;
		const result = loaded();
		result.snapshots = [version("s1", at, "a.md")];
		vi.setSystemTime(at + 60 * MINUTE - 10_000);
		const { draw } = harness([result]);
		draw();
		await settled();
		draw();
		const [first] = lastDrawn().rows;

		vi.setSystemTime(at + 60 * MINUTE + 10_000);
		vi.mocked(renderSessionCard).mockClear();
		draw();

		expect(lastDrawn().rows[0]).not.toBe(first);
	});
});
