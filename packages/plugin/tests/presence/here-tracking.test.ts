import { FileView } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { watchHere } from "@/presence/here";
import type { Here } from "@/presence/people";

const SETTLE_MS = 400;
const IDLE_MS = 5 * 60_000;
const CHECK_MS = 30_000;

type Listener = (...args: unknown[]) => void;

let windowEvents: EventTarget;
let documentEvents: EventTarget;
let visibility: string;

beforeEach(() => {
	vi.useFakeTimers();
	windowEvents = new EventTarget();
	documentEvents = new EventTarget();
	visibility = "visible";
	vi.stubGlobal("document", {
		get visibilityState() {
			return visibility;
		},
		addEventListener: documentEvents.addEventListener.bind(documentEvents),
		removeEventListener:
			documentEvents.removeEventListener.bind(documentEvents),
	});
	vi.stubGlobal(
		"addEventListener",
		windowEvents.addEventListener.bind(windowEvents),
	);
	vi.stubGlobal(
		"removeEventListener",
		windowEvents.removeEventListener.bind(windowEvents),
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function workspaceWith(shown: { active: string | null; open: string[] }) {
	const handlers = new Map<string, Set<Listener>>();
	const on = (name: string, listener: Listener) => {
		handlers.set(name, (handlers.get(name) ?? new Set()).add(listener));
		return { name, listener };
	};
	const offref = ({ name, listener }: { name: string; listener: Listener }) =>
		handlers.get(name)?.delete(listener);
	const app = {
		workspace: {
			getActiveFile: () =>
				shown.active === null ? null : { path: shown.active },
			iterateAllLeaves: (visit: (leaf: unknown) => void) => {
				for (const path of shown.open) {
					visit({
						view: Object.assign(Object.create(FileView.prototype), {
							file: { path },
						}),
						getContainer: () => ({ win: window }),
					});
				}
			},
			on,
			offref,
			onLayoutReady: (ready: () => void) => ready(),
		},
		vault: { on, offref },
	};
	return {
		app: app as never,
		fire: (name: string, ...args: unknown[]) => {
			for (const listener of handlers.get(name) ?? []) listener(...args);
		},
		listening: () =>
			[...handlers.values()].reduce((count, set) => count + set.size, 0),
	};
}

function watching(shown = { active: "a.md" as string | null, open: ["a.md"] }) {
	const workspace = workspaceWith(shown);
	const reports: Here[] = [];
	const watcher = watchHere(
		workspace.app,
		(here) => reports.push(here),
		() => true,
	);
	return { ...workspace, shown, reports, watcher };
}

describe("where this device is", () => {
	it("is reported once tabs stop changing, not on every flick", () => {
		const here = watching();
		expect(here.reports).toEqual([{ path: "a.md", idle: false }]);

		for (const path of ["b.md", "c.md", "d.md"]) {
			here.shown.active = path;
			here.shown.open = [path];
			here.fire("active-leaf-change");
			vi.advanceTimersByTime(SETTLE_MS - 1);
		}
		expect(here.reports).toHaveLength(1);
		vi.advanceTimersByTime(1);

		expect(here.reports.at(-1)).toEqual({ path: "d.md", idle: false });
		expect(here.reports).toHaveLength(2);
		here.watcher.stop();
	});

	it("follows a renamed note, and says nothing when nothing changed", () => {
		const here = watching();

		here.shown.active = "renamed.md";
		here.shown.open = ["renamed.md"];
		here.fire("rename");
		vi.advanceTimersByTime(SETTLE_MS);
		here.fire("layout-change");
		vi.advanceTimersByTime(SETTLE_MS);

		expect(here.reports.map(({ path }) => path)).toEqual([
			"a.md",
			"renamed.md",
		]);
		here.watcher.stop();
	});

	it("counts a note only while a tab shows it", () => {
		const here = watching({ active: "a.md", open: [] });

		expect(here.reports).toEqual([{ path: null, idle: false }]);
		here.shown.open = ["a.md"];
		here.fire("file-open");
		vi.advanceTimersByTime(SETTLE_MS);

		expect(here.reports.at(-1)).toEqual({ path: "a.md", idle: false });
		here.watcher.stop();
	});

	it("turns away after five idle minutes, and back at the next input", () => {
		const here = watching();

		vi.advanceTimersByTime(IDLE_MS - CHECK_MS);
		expect(here.reports).toHaveLength(1);
		vi.advanceTimersByTime(2 * CHECK_MS);
		expect(here.reports.at(-1)).toEqual({ path: "a.md", idle: true });

		windowEvents.dispatchEvent(new Event("wheel"));
		expect(here.reports.at(-1)).toEqual({ path: "a.md", idle: false });
		here.watcher.stop();
	});

	it("wakes at any kind of input, again and again", () => {
		const here = watching();

		for (const type of ["keydown", "pointerdown", "pointermove", "wheel"]) {
			vi.advanceTimersByTime(IDLE_MS + CHECK_MS);
			expect(here.reports.at(-1)?.idle).toBe(true);
			windowEvents.dispatchEvent(new Event(type));
			expect(here.reports.at(-1)?.idle).toBe(false);
		}
		here.watcher.stop();
	});

	it("is away at once when the window is hidden, and back when it shows", () => {
		const here = watching();

		visibility = "hidden";
		documentEvents.dispatchEvent(new Event("visibilitychange"));
		expect(here.reports.at(-1)).toEqual({ path: "a.md", idle: true });

		visibility = "visible";
		documentEvents.dispatchEvent(new Event("visibilitychange"));
		expect(here.reports.at(-1)).toEqual({ path: "a.md", idle: false });
		here.watcher.stop();
	});

	it("stops listening, reporting and counting time once stopped", () => {
		const here = watching();
		here.shown.active = "b.md";
		here.shown.open = ["b.md"];
		here.fire("active-leaf-change");

		here.watcher.stop();
		expect(here.listening()).toBe(0);
		vi.advanceTimersByTime(2 * IDLE_MS);
		windowEvents.dispatchEvent(new Event("keydown"));
		visibility = "hidden";
		documentEvents.dispatchEvent(new Event("visibilitychange"));

		expect(here.reports).toEqual([{ path: "a.md", idle: false }]);
		expect(vi.getTimerCount()).toBe(0);
	});
});
