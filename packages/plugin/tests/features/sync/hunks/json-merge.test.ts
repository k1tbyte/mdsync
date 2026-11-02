import { describe, expect, it } from "vitest";
import { mergeJsonByKey } from "@/features/sync/hunks/json-merge";

/** As Obsidian's `saveData` writes it. */
const json = (value: unknown, indent: string | number = 2) =>
	JSON.stringify(value, null, indent);

const merge = (base: unknown, local: unknown, remote: unknown) =>
	mergeJsonByKey(json(base), json(local), json(remote));

describe("mergeJsonByKey", () => {
	it.each([
		[
			"edits of different keys",
			{ a: 1, b: 1 },
			{ a: 2, b: 1 },
			{ a: 1, b: 2 },
			{ a: 2, b: 2 },
		],
		[
			"edits inside one nested object",
			{ view: { size: 1, theme: "a" } },
			{ view: { size: 2, theme: "a" } },
			{ view: { size: 1, theme: "b" } },
			{ view: { size: 2, theme: "b" } },
		],
		["the same edit on both sides", { a: 1 }, { a: 2 }, { a: 2 }, { a: 2 }],
		[
			"a key deleted on one side only",
			{ a: 1, b: 1 },
			{ a: 1 },
			{ a: 1, b: 1, c: 1 },
			{ a: 1, c: 1 },
		],
		["null added where nothing was", {}, { a: null }, {}, { a: null }],
		[
			"an array changed on one side, whole",
			{ list: [1, 2], a: 1 },
			{ list: [1, 2], a: 2 },
			{ list: [2, 1, 3], a: 1 },
			{ list: [2, 1, 3], a: 2 },
		],
	])("merges %s", (_, base, local, remote, merged) => {
		expect(merge(base, local, remote)).toBe(json(merged));
	});

	it.each([
		["different edits of one key", { a: 1 }, { a: 2 }, { a: 3 }],
		["a deletion against an edit", { a: 1 }, {}, { a: 2 }],
		["null against a deletion", { a: 1 }, { a: null }, {}],
		["one key added with two values", {}, { a: 1 }, { a: 2 }],
		[
			"two edits of one array",
			{ list: [1] },
			{ list: [1, 2] },
			{ list: [0, 1] },
		],
		["an object against a scalar", { a: { b: 1 } }, { a: { b: 2 } }, { a: 5 }],
	])("leaves %s to a person", (_, base, local, remote) => {
		expect(merge(base, local, remote)).toBeNull();
	});

	it("keeps local's key order, remote's new keys after it in their order", () => {
		const base = { a: 1, b: 1 };
		const local = { b: 2, a: 1 };
		const remote = { a: 1, b: 1, z: 1, y: 1 };
		expect(merge(base, local, remote)).toBe(
			'{\n  "b": 2,\n  "a": 1,\n  "z": 1,\n  "y": 1\n}',
		);
	});

	it("takes a reorder alone as no edit", () => {
		expect(merge({ a: 1, b: 1 }, { b: 1, a: 1 }, { a: 2, b: 1 })).toBe(
			json({ b: 1, a: 2 }),
		);
	});

	it("writes local's indent and final newline", () => {
		const base = json({ a: 1, b: 1 }, "\t");
		const local = `${json({ a: 2, b: 1 }, "\t")}\n`;
		const remote = json({ a: 1, b: 2 }, "\t");
		expect(mergeJsonByKey(base, local, remote)).toBe(
			`${json({ a: 2, b: 2 }, "\t")}\n`,
		);
	});

	it("keeps a __proto__ key as a key", () => {
		const base = '{\n  "__proto__": 1,\n  "a": 1\n}';
		const local = '{\n  "__proto__": 1,\n  "a": 2\n}';
		const remote = '{\n  "__proto__": 2,\n  "a": 1\n}';
		expect(mergeJsonByKey(base, local, remote)).toBe(
			'{\n  "__proto__": 2,\n  "a": 2\n}',
		);
	});

	it.each([
		["a side that is not JSON", "{", json({ a: 1 })],
		["a side not written by JSON.stringify", '{ "a": 2 }', json({ a: 1 })],
		[
			"an integer JavaScript would round",
			'{\n  "id": 12345678901234567890\n}',
			json({ id: 1 }),
		],
	])("refuses %s", (_, local, remote) => {
		expect(mergeJsonByKey(json({ a: 1 }), local, remote)).toBeNull();
	});
});
