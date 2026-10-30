// @vitest-environment jsdom

import { installElementMethods } from "@tests/helpers/element-methods";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceControlHost } from "@/features/source-control/host";
import { renderSessionCard } from "@/features/source-control/timeline/session-card";
import type { SessionRow } from "@/features/source-control/timeline/session-rows";
import { TimelineTab } from "@/features/source-control/timeline/timeline-tab";
import type { SnapshotListResult, SnapshotSummary } from "@/features/sync";
import type { EFileKind, ManifestEntry } from "@/features/sync/types";
import { buildCalendar } from "@/features/sync/ui/history/calendar";

const search = vi.hoisted(() => ({ change: (_value: string) => {} }));

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
		onChange(fn: (value: string) => void) {
			search.change = fn;
			return this;
		}
	},
	ButtonComponent: (await import("@tests/helpers/button-component"))
		.DomButtonComponent,
}));
vi.mock("@/features/sync/ui/history/calendar", async (importOriginal) => {
	const actual = await importOriginal<object>();
	return {
		...actual,
		buildCalendar: vi.fn(
			(actual as { buildCalendar: typeof buildCalendar }).buildCalendar,
		),
	};
});
vi.mock("@/features/source-control/timeline/session-card", () => ({
	renderSessionCard: vi.fn(),
}));

installElementMethods();
// jsdom has no layout, so it lacks scrollIntoView.
const scrollIntoView = vi.fn();
Element.prototype.scrollIntoView = scrollIntoView;

const NOW = new Date(2026, 9, 28, 18, 0).getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
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
	let pane!: HTMLElement;
	const draw = () => {
		pane = document.createElement("div");
		tab.render(pane, document.createElement("div"));
	};
	tab = new TimelineTab(plugin, draw, vi.fn(), vi.fn());
	return {
		tab,
		draw,
		listSnapshots,
		pane: () => pane,
	};
}

/** One push per hour on its own path, newest first: each is a session of its own. */
function many(count: number): SnapshotListResult {
	return {
		snapshots: Array.from({ length: count }, (_, index) =>
			version(`s${index}`, NOW - index * HOUR, `n${index}.md`),
		),
		lagging: false,
		truncated: false,
		activity: {},
	};
}

function pagerOf(pane: HTMLElement) {
	const buttons = Array.from(
		pane.querySelectorAll<HTMLButtonElement>(
			".mdsync-history-row-actions button",
		),
	);
	return {
		meta: pane.querySelector(
			".mdsync-history-row-actions .mdsync-history-row-meta",
		)?.textContent,
		next: buttons.find((button) => button.textContent === "Next page"),
	};
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

	it("says no pushes only when none was recorded, not when every version is hidden", async () => {
		const hidden = (activity: SnapshotListResult["activity"]) => ({
			...loaded(),
			snapshots: [
				{
					...version("s1", NOW - HOUR, "a.md"),
					files: { added: {}, modified: {}, deleted: {} },
				},
			],
			activity,
		});
		const { tab, draw, pane } = harness([
			hidden({}),
			hidden({ [Math.floor((NOW - HOUR) / HOUR)]: [2, 0] }),
		]);
		draw();
		await settled();
		expect(pane().textContent).toContain("No pushes yet");

		tab.clear();
		draw();
		await settled();
		expect(pane().textContent).not.toContain("No pushes yet");
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

describe("TimelineTab calendar", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
		vi.mocked(buildCalendar).mockClear();
	});
	afterEach(() => vi.useRealTimers());

	it("builds the calendar once per result and day, not on every redraw", async () => {
		const { tab, draw } = harness([loaded(), loaded()]);
		draw();
		await settled();
		draw();
		draw();
		expect(buildCalendar).toHaveBeenCalledTimes(1);

		vi.setSystemTime(NOW + DAY);
		draw();
		expect(buildCalendar).toHaveBeenCalledTimes(2);

		tab.clear();
		draw();
		await settled();
		expect(buildCalendar).toHaveBeenCalledTimes(3);
	});
});

describe("TimelineTab picked day", () => {
	const zone = process.env.TZ;
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
		vi.mocked(renderSessionCard).mockClear();
	});
	afterEach(() => {
		vi.useRealTimers();
		if (zone === undefined) delete process.env.TZ;
		else process.env.TZ = zone;
	});

	async function pick(result: SnapshotListResult, day: number) {
		const { tab, draw } = harness([result]);
		tab.showDay(day);
		draw();
		await settled();
		return lastDrawn().rows.map((row) => row.key);
	}

	it("lists a pinned version of the picked day, pinned first, and none of a later day", async () => {
		const day = new Date(2026, 9, 25).getTime();
		const at = (hour: number) => new Date(2026, 9, 25, hour).getTime();
		const pin = (id: string, when: number) => ({
			...version(id, when, `${id}.md`),
			pinned: true,
		});
		const keys = await pick(
			{
				snapshots: [
					pin("later-pin", NOW),
					version("later", NOW - HOUR, "x.md"),
					version("today", at(14), "a.md"),
					pin("today-pin", at(9)),
				],
				lagging: false,
				truncated: false,
				activity: {},
			},
			day,
		);

		expect(keys).toEqual(["today-pin", "today"]);
	});

	it("ends the day at the next local midnight when midnight is skipped", async () => {
		// Chile skips 2026-09-06 00:00, so that day starts at 01:00 and ends at the 7th's own midnight.
		process.env.TZ = "America/Santiago";
		vi.setSystemTime(new Date(2026, 8, 9, 12));
		const keys = await pick(
			{
				snapshots: [
					version("monday", new Date(2026, 8, 7, 0, 30).getTime(), "b.md"),
					version("sunday", new Date(2026, 8, 6, 12).getTime(), "a.md"),
				],
				lagging: false,
				truncated: false,
				activity: {},
			},
			new Date(2026, 8, 6).getTime(),
		);

		expect(keys).toEqual(["sunday"]);
	});
});

describe("TimelineTab paging", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
		vi.mocked(renderSessionCard).mockClear();
	});
	afterEach(() => vi.useRealTimers());

	it("renders 100 cards of 150 sessions with the pager, and the next page the rest", async () => {
		const { draw, pane } = harness([many(150)]);
		draw();
		await settled();
		vi.mocked(renderSessionCard).mockClear();
		draw();

		expect(lastDrawn().rows.map((row) => row.key)).toEqual(
			Array.from({ length: 100 }, (_, index) => `s${index}`),
		);
		expect(pagerOf(pane()).meta).toBe("1-100 of 150");

		vi.mocked(renderSessionCard).mockClear();
		scrollIntoView.mockClear();
		pagerOf(pane()).next?.click();

		expect(lastDrawn().rows.map((row) => row.key)).toEqual(
			Array.from({ length: 50 }, (_, index) => `s${index + 100}`),
		);
		// The new page reads from its first card, not from the calendar above it.
		expect(scrollIntoView).toHaveBeenCalledTimes(1);
		expect(pagerOf(pane()).meta).toBe("101-150 of 150");
	});

	it("repeats the age header at the top of a page when its group continues", async () => {
		const { draw, pane } = harness([many(150)]);
		draw();
		await settled();
		draw();
		const headers = (el: HTMLElement) =>
			Array.from(
				el.querySelectorAll(".mdsync-timeline-day span:first-child"),
			).map((span) => span.textContent);
		const first = headers(pane());
		pagerOf(pane()).next?.click();

		// Hourly pushes cross a few days, so the day cut by the page edge heads both pages.
		expect(first.at(-1)).toBe(headers(pane())[0]);
	});

	it("keeps the page across UI-only rerenders", async () => {
		const { draw, pane } = harness([many(150)]);
		draw();
		await settled();
		draw();
		pagerOf(pane()).next?.click();
		const { ctx } = lastDrawn();
		vi.mocked(renderSessionCard).mockClear();

		ctx?.toggle("s100");

		expect(lastDrawn().rows).toHaveLength(50);
		expect(pagerOf(pane()).meta).toBe("101-150 of 150");
	});

	it("starts over at page 1 on a new filter", async () => {
		const { draw, pane } = harness([many(150)]);
		draw();
		await settled();
		draw();
		pagerOf(pane()).next?.click();
		vi.mocked(renderSessionCard).mockClear();

		// Every path ends in .md, so all 150 still match and only the query changed.
		search.change(".md");

		expect(lastDrawn().rows).toHaveLength(100);
		expect(lastDrawn().rows[0]?.key).toBe("s0");
		expect(pagerOf(pane()).meta).toBe("1-100 of 150");
	});

	it("starts over at page 1 on a new result", async () => {
		const { tab, draw, pane } = harness([many(150), many(150)]);
		draw();
		await settled();
		draw();
		pagerOf(pane()).next?.click();

		tab.clear();
		draw();
		await settled();
		vi.mocked(renderSessionCard).mockClear();
		draw();

		expect(lastDrawn().rows).toHaveLength(100);
		expect(pagerOf(pane()).meta).toBe("1-100 of 150");
	});

	it("shows no pager for a short list", async () => {
		const { draw, pane } = harness([many(100)]);
		draw();
		await settled();
		draw();

		expect(pagerOf(pane()).meta).toBeUndefined();
	});
});
