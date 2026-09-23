import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { mergeThreeWay } from "@/live/merge";
import { patchYText } from "@/live/patch";

describe("mergeThreeWay", () => {
	it("takes the room when this device changed nothing", () => {
		expect(mergeThreeWay("a\nb", "a\nb", "a\nB")).toBe("a\nB");
	});

	it("takes this device's text when the room changed nothing", () => {
		expect(mergeThreeWay("a\nb", "a\nB", "a\nb")).toBe("a\nB");
	});

	it("combines changes to different lines", () => {
		expect(mergeThreeWay("a\nb\nc", "A\nb\nc", "a\nb\nC")).toBe("A\nb\nC");
	});

	it("keeps both sides of one line, the room's first", () => {
		expect(mergeThreeWay("a\nb\nc", "a\nmine\nc", "a\ntheirs\nc")).toBe(
			"a\ntheirs\nmine\nc",
		);
	});

	it("keeps an agreed change once", () => {
		expect(mergeThreeWay("a\nb\nc\nd", "a\nsame\nc\nD", "a\nsame\nc\nd")).toBe(
			"a\nsame\nc\nD",
		);
	});
});

describe("patchYText", () => {
	function patched(from: string, to: string): { text: string; ops: number } {
		const doc = new Y.Doc();
		const text = doc.getText("body");
		text.insert(0, from);
		let ops = 0;
		text.observe((event) => {
			ops = event.delta.filter((op) => op.retain === undefined).length;
		});
		patchYText(doc, text, to);
		return { text: text.toString(), ops };
	}

	it("edits the middle and leaves the ends alone", () => {
		expect(patched("hello world", "hello brave world")).toEqual({
			text: "hello brave world",
			ops: 1,
		});
	});

	it("never splits a surrogate pair", () => {
		const { text } = patched("a😀b", "a😃b");
		expect(text).toBe("a😃b");
		expect(text).not.toContain("�");
	});

	it("reaches the target past the edit budget", () => {
		const from = "x".repeat(3000);
		const to = "y".repeat(3000);
		expect(patched(`<${from}>`, `<${to}>`).text).toBe(`<${to}>`);
	});

	it("leaves an equal text untouched", () => {
		expect(patched("same", "same")).toEqual({ text: "same", ops: 0 });
	});
});
