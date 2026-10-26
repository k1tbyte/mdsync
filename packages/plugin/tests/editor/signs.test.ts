import { EditorState, Text } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";

import { registerEditorSigns } from "@/editor/signs";
import { signsField } from "@/editor/signs/gutter";
import {
	type ChangeMark,
	findChangeForLine,
	markedChanges,
	markPlace,
	presentSyncChange,
	shouldRedeliverBaseline,
	toCmText,
} from "@/editor/signs/helpers";
import { segmentRevert } from "@/editor/signs/hunk-revert";
import {
	changesField,
	compareTextField,
	setChangesEffect,
	setCompareTextEffect,
} from "@/editor/signs/state";
import { computeHunks, hunkSegments } from "@/sync/hunks";

const marksOf = (baseline: Text, current: Text): ChangeMark[] =>
	markedChanges(baseline, current).map(({ mark }) => mark);

const marks = (baseline: string, current: string): ChangeMark[] =>
	marksOf(toCmText(baseline), toCmText(current));

describe("signs helpers", () => {
	it("redelivers when compare text disappears after already being set", () => {
		expect(shouldRedeliverBaseline(Text.of(["before"]), null, false)).toBe(
			true,
		);
	});

	it("redelivers when compare text is missing but a cached baseline exists", () => {
		expect(shouldRedeliverBaseline(null, null, true)).toBe(true);
	});

	it("does not redeliver when compare text is already present", () => {
		expect(shouldRedeliverBaseline(null, Text.of(["current"]), true)).toBe(
			false,
		);
	});

	it("does not redeliver when nothing was previously loaded", () => {
		expect(shouldRedeliverBaseline(null, null, false)).toBe(false);
	});

	it("marks a new trailing line as an add instead of a changed previous line", () => {
		expect(
			marksOf(
				Text.of(["There is second"]),
				Text.of(["There is second", "asdasd"]),
			),
		).toMatchObject([{ from: 2, to: 2, kind: "add" }]);
	});

	it("marks removing the final line as a deletion after the line kept", () => {
		expect(
			marksOf(
				Text.of(["There is second", "asdasd"]),
				Text.of(["There is second"]),
			),
		).toMatchObject([{ from: 1, to: 1, kind: "delete" }]);
	});

	it("marks a change of the final newline alone on the line it opened or closed", () => {
		expect(marks("a\nb", "a\nb\n")).toMatchObject([
			{ from: 3, to: 3, kind: "add" },
		]);
		expect(marks("a\nb\n", "a\nb")).toMatchObject([
			{ from: 2, to: 2, kind: "delete" },
		]);
	});

	it("maps a clicked added line to the matching sync hunk index", () => {
		const changes = markedChanges(
			Text.of(["There is second"]),
			Text.of(["There is second", "asdasd", "hello world"]),
		);

		expect(findChangeForLine(changes, 2)?.change.hunk.index).toBe(0);
	});

	it("keeps edits that share a hunk apart", () => {
		const baseline = Text.of(["a", "b", "c", "d", "e", "f", ""]);
		const current = Text.of(["A", "b", "c", "d", "e", ""]);
		const changes = markedChanges(baseline, current);
		const at = (line: number) => {
			const found = findChangeForLine(changes, line);
			return found && presentSyncChange(found.change);
		};

		expect(
			computeHunks(baseline.toString(), current.toString()).hunks,
		).toHaveLength(1);
		expect(at(1)).toEqual({ removedLines: ["a"], addedLines: ["A"] });
		// The removed last line's mark sits on the line above the gap.
		expect(at(5)).toEqual({ removedLines: ["f"], addedLines: [] });
	});

	it("marks filling an existing blank line with text as an add", () => {
		expect(
			marksOf(Text.of(["", "tail"]), Text.of(["heading", "tail"])),
		).toMatchObject([{ from: 1, to: 1, kind: "add" }]);
	});

	it("marks filling the only blank line with multiple lines as adds", () => {
		expect(
			marksOf(Text.of([""]), Text.of(["asdasdas", "dasd", "sadas"])),
		).toMatchObject([{ from: 1, to: 3, kind: "add" }]);
	});

	it("marks exactly the lines a push takes while blank lines make the diff ambiguous", () => {
		const base = "L1\nL2\nL3\nL4\nL5\n";
		const steps: Array<[string, number, number]> = [
			["\n", 6, 6],
			["\nabc", 6, 7],
			["\nabc\n", 6, 7],
			["\nabc\ndef", 6, 8],
		];
		for (const [typed, from, to] of steps) {
			const [change] = markedChanges(toCmText(base), toCmText(base + typed));
			expect(change?.mark).toMatchObject({ from, to, kind: "add" });
			expect(change?.change.segment.right).toEqual([from - 1, to]);
		}
	});

	it("keeps the empty last line a trailing newline implies", () => {
		// Without it every file ending in a newline shows a phantom trailing add.
		expect(toCmText("a\nb\n").lines).toBe(3);
		expect(toCmText("a\nb").lines).toBe(2);
		expect(toCmText("a\r\nb\r\n").toString()).toBe("a\nb\n");
		expect(toCmText("").lines).toBe(1);
	});

	it("marks removed lines on the line above them, or the first line when they led the note", () => {
		const below = marks("a\nb\nc\n", "a\nc\n")[0];
		expect(below).toMatchObject({ from: 1, to: 1, kind: "delete" });
		expect(below && markPlace(below)).toBe("After line 1");
		expect(marks("a\nb\n", "b\n")[0]).toMatchObject({
			from: 1,
			kind: "topdelete",
		});
		// No final newline: the gap still follows the last line kept.
		expect(marks("a\nb", "a")[0]).toMatchObject({ from: 1, kind: "delete" });
		expect(marks("a\nb\nc", "a\nb")[0]).toMatchObject({
			from: 2,
			kind: "delete",
		});
		expect(marks("a\nb\nc\n", "a\nB\n")[0]).toMatchObject({
			from: 2,
			to: 2,
			kind: "change",
			removesBelow: true,
		});
	});

	it("marks a removal from below when the line above already holds a mark", () => {
		const changes = markedChanges(
			toCmText("a\nmiddle\nc\n"),
			toCmText("middle\n"),
		);
		const placed = changes.map(({ mark }) => mark);
		expect(placed).toMatchObject([
			{ from: 1, kind: "topdelete" },
			{ from: 2, kind: "topdelete" },
		]);
		expect(markPlace(placed[1] as ChangeMark)).toBe("After line 1");
		// Each opens its own change, the one a push would send.
		expect(findChangeForLine(changes, 2)).toBe(changes[1]);
		expect(changes[1]?.change.segment.left).toEqual([2, 3]);
	});

	it("maps a clicked line inside a changed run to the whole run", () => {
		const changes = markedChanges(
			Text.of(["one", "two", "three", "four", ""]),
			Text.of(["one", "TWO", "THREE", "four", ""]),
		);

		// The popup has to show every line the push sends, not just the click.
		expect(findChangeForLine(changes, 3)?.change.segment.right).toEqual([1, 3]);
	});

	it("returns nothing for a line far from every hunk", () => {
		const lines = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", ""];
		const changes = markedChanges(
			Text.of(lines),
			Text.of(lines.map((l) => (l === "a" ? "A" : l))),
		);
		expect(findChangeForLine(changes, 9)).toBeNull();
	});
});

describe("signs gutter field", () => {
	function stateWithSigns(doc: string, baseline: string): EditorState {
		const initial = EditorState.create({
			doc,
			extensions: [compareTextField, changesField, signsField],
		});
		const withBaseline = initial.update({
			effects: setCompareTextEffect.of(toCmText(baseline)),
		}).state;
		return withBaseline.update({
			effects: setChangesEffect.of({
				changes: markedChanges(toCmText(baseline), withBaseline.doc),
				doc: withBaseline.doc,
				lastDiffMs: 0,
			}),
		}).state;
	}

	it("maps its ranges through a document change it has not diffed yet", () => {
		const state = stateWithSigns("one\nTWO\nthree\n", "one\ntwo\nthree\n");
		expect(countMarkers(state)).toBeGreaterThan(0);

		// The recompute is debounced, so the next document arrives with no effects.
		const shrunk = state.update({
			changes: { from: 0, to: state.doc.length - 1 },
		}).state;

		const cursor = shrunk.field(signsField).iter();
		while (cursor.value) {
			expect(cursor.from).toBeLessThanOrEqual(shrunk.doc.length);
			cursor.next();
		}
	});

	it("drops every marker once the baseline is cleared", () => {
		const state = stateWithSigns("one\nTWO\n", "one\ntwo\n");
		const cleared = state.update({
			effects: setCompareTextEffect.of(null),
		}).state;
		expect(countMarkers(cleared)).toBe(0);
	});
});

function countMarkers(state: EditorState): number {
	let count = 0;
	const cursor = state.field(signsField).iter();
	while (cursor.value) {
		count++;
		cursor.next();
	}
	return count;
}

describe("signs registration", () => {
	it("subscribes only while editor signs are enabled", () => {
		const stub = createSignsPluginStub(false);
		const handle = registerEditorSigns(stub.plugin);

		expect(stub.registerEditorExtension).toHaveBeenCalledTimes(1);
		expect(stub.controller.subscribe).not.toHaveBeenCalled();
		expect(stub.vault.on).not.toHaveBeenCalled();
		expect(stub.workspace.on).not.toHaveBeenCalled();
		expect(stub.workspace.updateOptions).not.toHaveBeenCalled();

		handle.refresh(true);

		expect(stub.controller.subscribe).toHaveBeenCalledTimes(1);
		expect(stub.vault.on).toHaveBeenCalledTimes(1);
		expect(stub.workspace.on).toHaveBeenCalledTimes(1);
		expect(stub.workspace.updateOptions).toHaveBeenCalledTimes(1);

		handle.refresh(true);

		expect(stub.controller.subscribe).toHaveBeenCalledTimes(1);
		expect(stub.vault.on).toHaveBeenCalledTimes(1);
		expect(stub.workspace.on).toHaveBeenCalledTimes(1);

		handle.refresh(false);

		expect(stub.unsubController).toHaveBeenCalledTimes(1);
		expect(stub.vault.offref).toHaveBeenCalledWith(stub.renameRef);
		expect(stub.workspace.offref).toHaveBeenCalledWith(stub.fileOpenRef);
		expect(stub.workspace.updateOptions).toHaveBeenCalledTimes(2);

		handle.dispose();
		expect(stub.unsubController).toHaveBeenCalledTimes(1);
	});
});

function createSignsPluginStub(enabled: boolean) {
	const unsubController = vi.fn();
	const renameRef = { type: "rename" };
	const fileOpenRef = { type: "file-open" };
	const registerEditorExtension = vi.fn();
	const controller = {
		subscribe: vi.fn(() => unsubController),
	};
	const vault = {
		on: vi.fn(() => renameRef),
		offref: vi.fn(),
	};
	const workspace = {
		on: vi.fn(() => fileOpenRef),
		offref: vi.fn(),
		updateOptions: vi.fn(),
	};

	return {
		plugin: {
			controller,
			settings: { showEditorChangeSigns: enabled },
			registerEditorExtension,
			app: { vault, workspace },
		} as unknown as Parameters<typeof registerEditorSigns>[0],
		controller,
		vault,
		workspace,
		registerEditorExtension,
		unsubController,
		renameRef,
		fileOpenRef,
	};
}

describe("reverting a sync change", () => {
	function revert(baseline: string, current: string, index = 0): string {
		const doc = Text.of(current.split("\n"));
		const [hunk] = computeHunks(baseline, current).hunks;
		const segment = hunk && hunkSegments(hunk)[index];
		if (!segment) throw new Error("no segment");
		const { from, to, insert } = segmentRevert(
			doc,
			Text.of(baseline.split("\n")),
			segment,
		);
		return doc.replace(from, to, Text.of(insert.split("\n"))).toString();
	}

	it("reverts one edit and keeps its neighbour in the same hunk", () => {
		expect(revert("a\nb\nc\nd\n", "A\nb\nc\nD\n")).toBe("a\nb\nc\nD\n");
		expect(revert("a\nb\nc\nd\n", "A\nb\nc\n", 1)).toBe("A\nb\nc\nd\n");
	});

	it.each([
		["a changed last line with no newline", "a\nb", "a\nc"],
		["a newline added at the end", "a\nb", "a\nb\n"],
		["lines added after a last line with no newline", "a\nb", "a\nb\nc\n"],
		["a newline taken from the end", "a\nb\n", "a\nb"],
		[
			"a changed middle line",
			"a\nb\nc\nd\ne\nf\ng\nh\n",
			"a\nB\nc\nd\ne\nf\ng\nh\n",
		],
		["everything added to an empty note", "", "x\n"],
	])("restores the baseline after %s", (_, baseline, current) => {
		expect(revert(baseline, current)).toBe(baseline);
	});
});
