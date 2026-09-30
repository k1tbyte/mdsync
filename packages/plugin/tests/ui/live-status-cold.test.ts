import { note, statusOf } from "@tests/helpers/live-status";
import { describe, expect, it } from "vitest";

import type { ColdCause } from "@/live/sessions";
import { RELAY_TEXT } from "@/ui/live/relay-text";

const TEAM = { id: "team", root: "Team" };
const READ_ONLY_TEAM = { ...TEAM, readOnly: true as const };
const DRAWING = { frontmatter: { "excalidraw-plugin": "parsed" } };
const MIB = 1024 * 1024;

const CAUSES: [ColdCause, RegExp][] = [
	["too-large", /^Too large to edit live/],
	["too-many", /^Too many notes open live/],
	["read-only", /^Read-only/],
	["moved-away", /room moved away/],
	["empty", /nobody edits it live yet/],
	["diverged", /differs from the live one/],
];

describe("why an open note is cold", () => {
	it.each(CAUSES)("says what a %s note is waiting on", (cold, label) => {
		const status = statusOf({ cold });

		expect(status?.state).toBe("cold");
		expect(status?.label).toMatch(label);
	});

	it("gives every cause its own words", () => {
		const labels = CAUSES.map(([cold]) => statusOf({ cold })?.label);

		expect(new Set(labels).size).toBe(CAUSES.length);
	});

	it("says live editing is off before any other reason", () => {
		const status = statusOf({ liveEditing: false, cold: "too-large" });

		expect(status).toEqual({
			state: "cold",
			label: expect.stringMatching(/^Live editing is off/),
		});
	});

	it("calls a read-only share's note read-only when nothing else keeps it cold", () => {
		const status = statusOf({ spaces: [READ_ONLY_TEAM] }, note("Team/a.md"));

		expect(status?.state).toBe("cold");
		expect(status?.label).toMatch(/^Read-only/);
	});

	it("says a file is no live note when Obsidian has not indexed it or another view holds it", () => {
		const unindexed = statusOf({ cache: null });
		const inAnotherView = statusOf({ viewType: "excalidraw" });
		const drawingInTextView = statusOf({ cache: DRAWING });
		const notAMarkdownFile = statusOf({}, note("board.canvas"));

		for (const status of [
			unindexed,
			inAnotherView,
			drawingInTextView,
			notAMarkdownFile,
		]) {
			expect(status).toEqual({
				state: "cold",
				label: expect.stringMatching(/^Not a live note/),
			});
		}
	});

	it("takes a drawing in Excalidraw's own view as live-able up to a MiB", () => {
		const own = { cache: DRAWING, viewType: "excalidraw" };

		expect(statusOf(own, note("d.md", MIB))?.label).toMatch(
			/^Waiting for the key/,
		);
		expect(statusOf(own, note("d.md", MIB + 1))?.label).toMatch(/^Too large/);
	});

	it("says reading view is not live, and names the key only for a note in the editor", () => {
		const reading = statusOf({ mode: "preview" });
		const editing = statusOf({ mode: "source" });

		expect(reading?.label).toMatch(/not in reading view/);
		expect(editing?.label).toMatch(/^Waiting for the key/);
	});
});

describe("what outranks what in a note's live status", () => {
	it("is live in its room, in words that say read-only for a read-only share", () => {
		const writable = statusOf({ room: true });
		const readOnly = statusOf(
			{ room: true, spaces: [READ_ONLY_TEAM] },
			note("Team/a.md"),
		);

		expect(writable).toEqual({
			state: "live",
			label: expect.stringMatching(/edits reach everyone/),
		});
		expect(readOnly).toEqual({
			state: "live",
			label: expect.stringMatching(/^Live, read-only/),
		});
	});

	it("prefers a live room over a cause it once went cold for", () => {
		expect(statusOf({ room: true, cold: "moved-away" })?.state).toBe("live");
	});

	it("waits for a room before giving up on it, and gives up before naming a cold reason", () => {
		expect(statusOf({ joining: true, unanswered: true })?.state).toBe(
			"joining",
		);
		expect(statusOf({ unanswered: true, cold: "too-large" })?.state).toBe(
			"offline",
		);
	});

	it("is not live while the socket is down or coming back, whatever the room last did", () => {
		expect(statusOf({ status: "offline", room: true })).toEqual({
			state: "offline",
			label: RELAY_TEXT.offline,
		});
		expect(statusOf({ status: "connecting", room: true })).toEqual({
			state: "joining",
			label: RELAY_TEXT.connecting,
		});
	});
});
