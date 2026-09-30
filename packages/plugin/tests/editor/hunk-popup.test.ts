import { Chunk } from "@codemirror/merge";
import { EditorState, type Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import {
	findChunkForLine,
	hunkTitle,
	presentSyncHunk,
	toCmText,
} from "@/editor/signs/helpers";
import {
	chunkRevert,
	syncHunkRevert,
	type TextChange,
} from "@/editor/signs/hunk-revert";
import { placePopup } from "@/editor/signs/popup-placement";
import { computeHunks } from "@/sync/hunks";

function only<T>(list: readonly T[]): T {
	const [item] = list;
	if (item === undefined) throw new Error("expected one item");
	return item;
}

const VIEWPORT = { width: 1000, height: 800 };
const POPUP = { width: 200, height: 100 };

function applied(doc: Text, change: TextChange): string {
	return EditorState.create({ doc })
		.update({ changes: change })
		.state.doc.toString();
}

function revertedBySyncHunk(baseline: string, current: string): string[] {
	const base = toCmText(baseline);
	const doc = toCmText(current);
	return computeHunks(baseline, current).hunks.map((hunk) =>
		applied(doc, syncHunkRevert(doc, base, hunk)),
	);
}

describe("placePopup", () => {
	it("opens just below and right of the click", () => {
		expect(placePopup({ x: 100, y: 100 }, POPUP, VIEWPORT)).toEqual({
			x: 108,
			y: 108,
		});
	});

	it("slides left to stay inside the right edge", () => {
		expect(placePopup({ x: 950, y: 100 }, POPUP, VIEWPORT).x).toBe(792);
	});

	it("flips above the click when it would run off the bottom", () => {
		expect(placePopup({ x: 100, y: 750 }, POPUP, VIEWPORT).y).toBe(642);
	});

	it("keeps a margin from the top and left when it fits nowhere", () => {
		const tall = { width: 1200, height: 900 };

		expect(placePopup({ x: 100, y: 50 }, tall, VIEWPORT)).toEqual({
			x: 8,
			y: 8,
		});
	});
});

describe("hunkTitle", () => {
	it("names what the hunk did", () => {
		expect(hunkTitle(1, 1)).toBe("Changes since last sync");
		expect(hunkTitle(0, 2)).toBe("Added since last sync");
		expect(hunkTitle(3, 0)).toBe("Removed since last sync");
	});
});

describe("presentSyncHunk", () => {
	it("splits a hunk into removed and added lines and drops context", () => {
		const hunk = only(computeHunks("a\nb\nc\n", "a\nB\nc\n").hunks);

		expect(presentSyncHunk(hunk)).toEqual({
			removedLines: ["b"],
			addedLines: ["B"],
		});
	});
});

describe("syncHunkRevert", () => {
	it("puts a changed line in the middle of a note back", () => {
		const baseline = "a\nb\nc\nd\ne\nf\ng\nh\n";
		const current = "a\nB\nc\nd\ne\nf\ng\nh\n";

		expect(revertedBySyncHunk(baseline, current)).toEqual([baseline]);
	});

	it("brings back lines that were deleted", () => {
		const baseline = "a\nb\nc\nd\ne\nf\ng\nh\n";
		const current = "a\nb\nc\nd\ne\nf\n";

		expect(revertedBySyncHunk(baseline, current)).toEqual([baseline]);
	});

	it("takes away lines that were added at the end", () => {
		const baseline = "a\nb\n";

		expect(revertedBySyncHunk(baseline, "a\nb\nc\nd\n")).toEqual([baseline]);
	});

	it("ends the restored last line with a newline so it cannot merge into what follows", () => {
		const doc = toCmText("one\nTWO");
		const hunk = only(computeHunks("one\ntwo", "one\nTWO").hunks);

		expect(syncHunkRevert(doc, toCmText("one\ntwo"), hunk).insert).toBe(
			"one\ntwo\n",
		);
	});

	it("leaves the restored text alone where nothing is replaced", () => {
		const doc = toCmText("");
		const hunk = only(computeHunks("a\n", "").hunks);

		const { from, to, insert } = syncHunkRevert(doc, toCmText("a\n"), hunk);

		expect([from, to, insert]).toEqual([0, 0, "a\n"]);
	});
});

describe("chunkRevert", () => {
	it("restores the baseline text of a chunk", () => {
		const baseline = toCmText("one\ntwo\nthree\n");
		const doc = toCmText("one\nTWO\nthree\n");
		const chunk = only(Chunk.build(baseline, doc));

		expect(applied(doc, chunkRevert(doc, baseline, chunk))).toBe(
			"one\ntwo\nthree\n",
		);
	});

	it("clamps a chunk that reaches past either text", () => {
		const baseline = toCmText("abc");
		const doc = toCmText("xy");
		const beyond = new Chunk([], 0, 99, 0, 99);

		expect(chunkRevert(doc, baseline, beyond)).toEqual({
			from: 0,
			to: 2,
			insert: "abc",
		});
	});
});

describe("findChunkForLine", () => {
	const baseline = toCmText("a\nb\nc\nd\ne\n");

	it("finds the chunk a line of an edit belongs to", () => {
		const doc = toCmText("a\nB1\nB2\nc\nd\ne\n");
		const chunks = Chunk.build(baseline, doc);

		expect(findChunkForLine(chunks, doc, 3)).toBe(chunks[0]);
	});

	it("places a pure deletion on the line that follows it", () => {
		const doc = toCmText("a\nb\nd\ne\n");
		const chunks = Chunk.build(baseline, doc);

		expect(findChunkForLine(chunks, doc, 3)).toBe(chunks[0]);
		expect(findChunkForLine(chunks, doc, 1)).toBeNull();
	});

	it("finds nothing for a line outside every chunk", () => {
		const doc = toCmText("a\nB\nc\nd\ne\n");

		expect(findChunkForLine(Chunk.build(baseline, doc), doc, 5)).toBeNull();
	});
});
