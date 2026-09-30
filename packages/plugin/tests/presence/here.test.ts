import { FileView } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { watchHere } from "@/presence/here";
import type { Here } from "@/presence/people";

const NOTE = "Team/a.md";

type Listener = (...args: unknown[]) => void;

/** A popout's window: its own listeners and visibility. */
function popout(visibilityState = "visible") {
	const listeners = new Map<string, Listener>();
	const win = {
		addEventListener: (type: string, listener: Listener) =>
			listeners.set(type, listener),
		removeEventListener: (type: string) => listeners.delete(type),
		document: {
			visibilityState,
			addEventListener: () => {},
			removeEventListener: () => {},
		},
	};
	return { win: win as unknown as Window, listeners };
}

function app(events = new Map<string, Listener>(), leafWindow?: Window) {
	const view = Object.assign(Object.create(FileView.prototype), {
		file: { path: NOTE },
	});
	const leaf = { view, getContainer: () => ({ win: leafWindow ?? window }) };
	return {
		workspace: {
			getActiveFile: () => ({ path: NOTE }),
			iterateAllLeaves: (visit: (leaf: unknown) => void) => visit(leaf),
			on: (name: string, listener: Listener) => {
				events.set(name, listener);
				return {};
			},
			offref: () => {},
			onLayoutReady: (ready: () => void) => ready(),
		},
		vault: { on: () => ({}), offref: () => {} },
	} as never;
}

function watch(initial: boolean) {
	let showNote = initial;
	const reports: Here[] = [];
	const watcher = watchHere(
		app(),
		(here) => reports.push(here),
		() => showNote,
	);
	return {
		reports,
		watcher,
		show(next: boolean) {
			showNote = next;
			watcher.refresh();
		},
	};
}

describe("watchHere", () => {
	afterEach(() => vi.unstubAllGlobals());

	function stubDom(): void {
		vi.stubGlobal("document", {
			visibilityState: "visible",
			addEventListener: () => {},
			removeEventListener: () => {},
		});
		vi.stubGlobal("addEventListener", () => {});
		vi.stubGlobal("removeEventListener", () => {});
	}

	it("announces the open note", () => {
		stubDom();
		const { reports, watcher } = watch(true);

		expect(reports).toEqual([{ path: NOTE, idle: false }]);
		watcher.stop();
	});

	it("announces presence without the note while it is hidden", () => {
		stubDom();
		const { reports, watcher } = watch(false);

		expect(reports).toEqual([{ path: null, idle: false }]);
		watcher.stop();
	});

	it("follows the setting on refresh, once per change", () => {
		stubDom();
		const { reports, show, watcher } = watch(true);

		show(false);
		show(false);
		show(true);

		expect(reports.map(({ path }) => path)).toEqual([NOTE, null, NOTE]);
		watcher.stop();
	});

	it("counts input in a popout, and is away only when every window is hidden", () => {
		vi.useFakeTimers();
		stubDom();
		vi.stubGlobal("document", { ...document, visibilityState: "hidden" });
		const restored = popout();
		const events = new Map<string, Listener>();
		const reports: Here[] = [];
		const watcher = watchHere(
			app(events, restored.win),
			(here) => reports.push(here),
			() => true,
		);
		expect(reports).toEqual([{ path: NOTE, idle: false }]);

		vi.advanceTimersByTime(6 * 60_000);
		expect(reports.at(-1)).toEqual({ path: NOTE, idle: true });
		restored.listeners.get("keydown")?.();
		expect(reports.at(-1)).toEqual({ path: NOTE, idle: false });

		const opened = popout("hidden");
		events.get("window-open")?.({}, opened.win);
		events.get("window-close")?.({}, restored.win);
		vi.advanceTimersByTime(30_000);
		expect(reports.at(-1)).toEqual({ path: NOTE, idle: true });
		watcher.stop();
		vi.useRealTimers();
	});

	it("listens on no popout once stopped before the layout was ready", () => {
		stubDom();
		const restored = popout();
		const unready = app(new Map(), restored.win) as {
			workspace: { onLayoutReady: (ready: () => void) => void };
		};
		let ready = () => {};
		unready.workspace.onLayoutReady = (later) => {
			ready = later;
		};
		watchHere(
			unready as never,
			() => {},
			() => true,
		).stop();
		ready();
		expect(restored.listeners.size).toBe(0);
	});
});
