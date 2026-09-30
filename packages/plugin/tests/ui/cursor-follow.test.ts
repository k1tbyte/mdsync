import type { Editor } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WatchedCursor } from "@/live/text/cursors";
import { CursorFollow } from "@/ui/live/cursor-follow";

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
