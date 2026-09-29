import { FileView } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { watchHere } from "@/presence/here";
import type { Here } from "@/presence/people";

const NOTE = "Team/a.md";

function app() {
	const view = Object.assign(Object.create(FileView.prototype), {
		file: { path: NOTE },
	});
	return {
		workspace: {
			getActiveFile: () => ({ path: NOTE }),
			iterateAllLeaves: (visit: (leaf: unknown) => void) => visit({ view }),
			on: () => ({}),
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
});
