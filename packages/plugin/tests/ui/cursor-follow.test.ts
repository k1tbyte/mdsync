import type { Editor, MarkdownView, WorkspaceLeaf } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LiveSession } from "@/live/session/session";
import { type WatchedCursor, watchCursor } from "@/live/text/cursors";
import type { PluginHost } from "@/plugin/host";
import { CursorFollow, followCursor } from "@/ui/live/header/cursor-follow";

vi.mock("@/live/text/cursors", () => ({ watchCursor: vi.fn() }));

const ROOM = {};

function setup() {
	const editor = {
		offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
		scrollIntoView: vi.fn(),
	};
	const input = new EventTarget();
	let changed = () => {};
	const person = { at: 5 as number | null, present: true, shown: true };
	const unwatch = vi.fn(() => {
		changed = () => {};
	});
	const cursor: WatchedCursor = {
		at: () => person.at,
		present: () => person.present,
		watch(listener) {
			changed = listener;
			return unwatch;
		},
	};
	const follows = new CursorFollow();
	follows.start({
		room: ROOM,
		key: "alex",
		editor: editor as unknown as Editor,
		input: input as HTMLElement,
		cursor,
		shown: () => person.shown,
	});
	const scrolledTo = () =>
		editor.scrollIntoView.mock.calls.map(([range]) => range.from.ch);
	return {
		editor: editor as unknown as Editor,
		input,
		person,
		unwatch,
		follows,
		scrolledTo,
		/** Their cursor may have moved; the follow answers on the next frame. */
		move: () => {
			changed();
			vi.runOnlyPendingTimers();
		},
		changed: () => changed(),
	};
}

describe("following a cursor", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("scrolls once a frame, never inside the change event", () => {
		const { person, changed, scrolledTo } = setup();

		person.at = 40;
		changed();
		changed();
		expect(scrolledTo()).toEqual([5]);
		vi.runOnlyPendingTimers();
		expect(scrolledTo()).toEqual([5, 40]);
	});

	it("keeps it in view as it moves, and waits while it is gone", () => {
		const { person, move, scrolledTo, follows, editor } = setup();

		person.at = 40;
		move();
		move();
		person.at = null;
		move();
		person.at = 60;
		move();

		expect(scrolledTo()).toEqual([5, 40, 60]);
		expect(follows.of(ROOM, editor)).toBe("alex");
		expect(follows.of({}, editor)).toBeNull();
	});

	it("ends on this device's own input", () => {
		const { input, person, move, scrolledTo, follows, editor, unwatch } =
			setup();

		input.dispatchEvent(new Event("wheel"));
		person.at = 40;
		move();

		expect(scrolledTo()).toEqual([5]);
		expect(unwatch).toHaveBeenCalledOnce();
		expect(follows.of(ROOM, editor)).toBeNull();
	});

	it("ends once the view shows another note, never scrolling it", () => {
		const { person, move, follows, editor, unwatch, scrolledTo } = setup();

		person.shown = false;
		person.at = 40;
		move();

		expect(scrolledTo()).toEqual([5]);
		expect(unwatch).toHaveBeenCalledOnce();
		expect(follows.of(ROOM, editor)).toBeNull();
	});

	it("ends when the person leaves the room", () => {
		const { person, move, follows, editor, unwatch } = setup();

		person.present = false;
		move();

		expect(unwatch).toHaveBeenCalledOnce();
		expect(follows.of(ROOM, editor)).toBeNull();
	});
});

describe("starting to follow", () => {
	it("scrolls to their cursor and leaves the caret where it was", () => {
		const editor = {
			offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
			scrollIntoView: vi.fn(),
			setCursor: vi.fn(),
		};
		const contentEl = new EventTarget();
		const file = { path: "a.md" };
		const session = {} as LiveSession;
		const markdown = { editor, file, contentEl } as unknown as MarkdownView;
		const leaf = { view: markdown } as unknown as WorkspaceLeaf;
		const setActiveLeaf = vi.fn();
		const plugin = {
			app: { workspace: { setActiveLeaf } },
			realtime: { live: { roomOf: () => session } },
		} as unknown as PluginHost;
		vi.mocked(watchCursor).mockReturnValue({
			at: () => 5,
			present: () => true,
			watch: () => () => {},
		});
		const follows = new CursorFollow();

		followCursor({
			plugin,
			leaf,
			markdown,
			session,
			key: "alex",
			offset: 5,
			follows,
		});

		expect(setActiveLeaf).toHaveBeenCalledWith(leaf, { focus: true });
		expect(editor.scrollIntoView).toHaveBeenCalled();
		expect(editor.setCursor).not.toHaveBeenCalled();
		expect(follows.of(session, editor as unknown as Editor)).toBe("alex");

		contentEl.dispatchEvent(new Event("keydown"));

		expect(follows.of(session, editor as unknown as Editor)).toBeNull();
		expect(editor.setCursor).not.toHaveBeenCalled();
	});
});
