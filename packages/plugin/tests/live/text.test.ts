import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { mergeThreeWay } from "@/live/text/merge";
import { patchYText } from "@/live/text/patch";
import { commonEnds } from "@/sync/hunks";

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

	it("combines changes to neighbouring lines", () => {
		expect(mergeThreeWay("a\nb", "A\nb", "a\nB")).toBe("A\nB");
		expect(mergeThreeWay("a\nb", "a\nb\nc", "a\nB")).toBe("a\nB\nc");
		expect(mergeThreeWay("a\nb", "a\nb\n", "a\nB")).toBe("a\nB\n");
	});

	it("keeps both of two inserts at one point", () => {
		expect(mergeThreeWay("a\nc", "a\nx\nc", "a\ny\nc")).toBe("a\ny\nx\nc");
	});

	it("writes lines two inserts at one point open or close with once", () => {
		expect(
			mergeThreeWay("plan\n", "plan\nsame\nmine\n", "top\nplan\nsame\n"),
		).toBe("top\nplan\nsame\nmine\n");
		expect(mergeThreeWay("a\nc", "a\nx\nend\nc", "a\ny\nend\nc")).toBe(
			"a\ny\nx\nend\nc",
		);
		// Repeats stay repeated: only what the shorter side holds is shared.
		expect(mergeThreeWay("", "x\nx", "x")).toBe("x\nx");
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

describe("patchYText edits", () => {
	function edited(from: string, to: string) {
		const doc = new Y.Doc();
		const text = doc.getText("body");
		text.insert(0, from);
		let delta: Y.YTextEvent["delta"] = [];
		text.observe((event) => {
			delta = event.delta;
		});
		patchYText(doc, text, to);
		let items = 0;
		for (let item = text._start; item; item = item.right) items++;
		const changes = delta.filter((op) => op.retain === undefined);
		return {
			text: text.toString(),
			delta,
			items,
			ops: changes.length,
			inserted: changes.reduce(
				(n, op) => n + (typeof op.insert === "string" ? op.insert.length : 0),
				0,
			),
			deleted: changes.reduce((n, op) => n + (op.delete ?? 0), 0),
		};
	}

	const paragraphs = [
		"Alpha is the first topic, and it talks about the planning of the work for the quarter in some detail.",
		"Beta is the second topic, covering the budget and the people who will be needed for the whole thing.",
		"Gamma is the third topic, which is about risks, the mitigation of them, and who is responsible for it.",
	];

	it("replaces a rewritten sentence in one piece", () => {
		const from =
			"Intro.\n\nThe quick brown fox jumps over the lazy dog near the river bank. Outro.";
		const to =
			"Intro.\n\nA fast red fox leaps above the sleepy hound close to the stream shore. Outro.";
		const result = edited(from, to);
		expect(result.text).toBe(to);
		expect(result.ops).toBe(2);
		expect(result.items).toBeLessThanOrEqual(4);
	});

	it("fixes a typo with a one or two character edit", () => {
		for (const [from, to] of [
			["I saw teh cat.", "I saw the cat."],
			["Please recieve it.", "Please receive it."],
			["Meet on Tuesday.", "Meet on Thursday."],
		] as const) {
			const result = edited(from, to);
			expect(result.text).toBe(to);
			expect(result.inserted).toBeLessThanOrEqual(3);
			expect(result.deleted).toBeLessThanOrEqual(3);
		}
	});

	it("keeps distant edits apart and the text between them untouched", () => {
		const middle = "\nThe line between the two edits stays as it is.\n";
		const result = edited(
			`alpha old alpha${middle}omega old omega`,
			`alpha new alpha${middle}omega new omega`,
		);
		expect(result).toMatchObject({ ops: 4, inserted: 6, deleted: 6 });
	});

	it("touches a reordered paragraph pair as blocks", () => {
		const from = paragraphs.join("\n\n");
		const to = [paragraphs[2], paragraphs[1], paragraphs[0]].join("\n\n");
		const result = edited(from, to);
		expect(result.text).toBe(to);
		expect(result.ops).toBeLessThanOrEqual(4);
		expect(result.items).toBeLessThanOrEqual(8);
	});

	it("appends a line as one insert", () => {
		const result = edited("one\ntwo\n", "one\ntwo\nthree\n");
		expect(result).toMatchObject({ ops: 1, inserted: 6, deleted: 0, items: 1 });
	});

	it("folds a shared run only under ten characters", () => {
		const around = (run: string) =>
			edited(`[1111${run}2222]`, `[3333${run}4444]`);
		expect(around("abcdefghi").ops).toBe(2);
		expect(around("abcdefghij").ops).toBe(4);
	});

	it("keeps a concurrent edit of the text between two inserts", () => {
		const mine = new Y.Doc();
		const theirs = new Y.Doc();
		mine.getText("body").insert(0, "- [ ] a");
		Y.applyUpdate(theirs, Y.encodeStateAsUpdate(mine));

		const ticked = theirs.getText("body");
		ticked.delete(3, 1);
		ticked.insert(3, "x");
		patchYText(mine, mine.getText("body"), "- new1\n- [ ] a\n- new2");
		Y.applyUpdate(theirs, Y.encodeStateAsUpdate(mine));
		Y.applyUpdate(mine, Y.encodeStateAsUpdate(theirs));

		expect(mine.getText("body").toString()).toBe("- new1\n- [x] a\n- new2");
		expect(theirs.getText("body").toString()).toBe("- new1\n- [x] a\n- new2");
	});

	it("reaches any target and leaves the shared ends alone", () => {
		let seed = 7;
		const random = (n: number) => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return (seed >>> 8) % n;
		};
		const pieces = ["a", "b", " ", "\n", "😀", "é", "中", "the ", "lorem "];
		const word = (max: number) =>
			Array.from(
				{ length: random(max) },
				() => pieces[random(pieces.length)],
			).join("");
		const expectPatched = (from: string, to: string) => {
			const result = edited(from, to);
			expect(result.text).toBe(to);
			const { head, tail } = commonEnds(Array.from(from), Array.from(to));
			const chars = Array.from(from);
			const untouchedHead = chars.slice(0, head).join("").length;
			const untouchedTail = chars.slice(chars.length - tail).join("").length;
			const first = result.delta[0];
			if (first)
				expect(first.retain ?? 0).toBeGreaterThanOrEqual(untouchedHead);
			const consumed = result.delta.reduce(
				(n, op) => n + (op.retain ?? 0) + (op.delete ?? 0),
				0,
			);
			expect(consumed).toBeLessThanOrEqual(from.length - untouchedTail);
			return result;
		};

		for (let round = 0; round < 300; round++) {
			const from = word(40);
			let to = from;
			for (let edits = random(4); edits > 0; edits--) {
				const chars = Array.from(to);
				const start = random(chars.length + 1);
				chars.splice(start, random(6), ...Array.from(word(8)));
				to = chars.join("");
			}
			if (random(5) === 0) to = word(40);
			expectPatched(from, to);
		}

		const long = () =>
			Array.from({ length: 1500 }, () => pieces[random(pieces.length)]).join(
				"",
			);
		expect(expectPatched(long(), long()).ops).toBeLessThanOrEqual(2);
	});
});
