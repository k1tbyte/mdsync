import type { MarkdownView } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LiveSession } from "@/live/session/session";
import { watchCursor } from "@/live/text/cursors";
import { trackCursor } from "@/ui/live/header/follow-scroll";

vi.mock("@/live/text/cursors", () => ({ watchCursor: vi.fn() }));

/** A 400px view; each offset is a 10px line. */
function setup(at: number | null) {
	const cursor = { at };
	let changed = () => {};
	vi.mocked(watchCursor).mockReturnValue({
		at: () => cursor.at,
		present: () => true,
		watch: (listener) => {
			changed = listener;
			return () => {
				changed = () => {};
			};
		},
	});
	const editor = {
		offsetToPos: (offset: number) => ({ line: offset, ch: 0 }),
		scrollIntoView: vi.fn(),
		cm: {
			coordsAtPos: (offset: number) => ({
				top: offset * 10,
				bottom: offset * 10 + 10,
			}),
			scrollDOM: {
				getBoundingClientRect: () => ({ top: 0, bottom: 400, height: 400 }),
			},
		},
	};
	const stop = trackCursor(
		{ editor } as unknown as MarkdownView,
		{} as LiveSession,
		"alex",
	);
	return {
		cursor,
		stop,
		scrolls: () => editor.scrollIntoView.mock.calls,
		move: () => {
			changed();
			changed();
			vi.runOnlyPendingTimers();
		},
	};
}

describe("tracking a followed cursor", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("centres a cursor near an edge, once a frame", () => {
		const { cursor, move, scrolls } = setup(2);
		vi.runOnlyPendingTimers();
		expect(scrolls()).toEqual([
			[{ from: { line: 2, ch: 0 }, to: { line: 2, ch: 0 } }, true],
		]);

		cursor.at = 80;
		move();
		expect(scrolls()).toHaveLength(2);
	});

	it("leaves the view still while the cursor stays in its middle", () => {
		const { cursor, move, scrolls } = setup(20);
		vi.runOnlyPendingTimers();
		cursor.at = 25;
		move();

		expect(scrolls()).toEqual([]);
	});

	it("waits while they have no cursor, and stops on request", () => {
		const { cursor, move, scrolls, stop } = setup(null);
		move();
		expect(scrolls()).toEqual([]);

		stop();
		cursor.at = 80;
		move();
		expect(scrolls()).toEqual([]);
	});
});
