import { describe, expect, it } from "vitest";
import { alignJsonSides } from "@/features/sync/hunks/json-align";
import { buildMergeSession } from "@/features/sync/hunks/merge-model";

const json = (value: unknown, indent: string | number = 2) =>
	JSON.stringify(value, null, indent);

describe("alignJsonSides", () => {
	it("leaves no change where only the key order differs", () => {
		const local = json({ theme: "dark", font: 14, nested: { a: 1, b: 2 } });
		const remote = json({ nested: { b: 2, a: 1 }, font: 14, theme: "dark" });

		const aligned = alignJsonSides(local, local, remote);

		expect(aligned?.remote).toBe(local);
		const session = buildMergeSession(
			aligned?.base ?? "",
			local,
			aligned?.remote ?? "",
		);
		expect(session.changes).toHaveLength(0);
	});

	it("keeps real changes, with keys local lacks after local's own", () => {
		const local = json({ a: 1, b: 2 });
		const remote = json({ c: 3, b: 5, a: 1 });

		expect(alignJsonSides(local, local, remote)?.remote).toBe(
			json({ a: 1, b: 5, c: 3 }),
		);
	});

	it("follows local's indent and final newline", () => {
		const local = `${json({ a: 1, b: 2 }, "\t")}\n`;
		const remote = json({ b: 2, a: 1 }, 4);

		expect(alignJsonSides(remote, local, remote)).toEqual({
			base: local,
			remote: local,
		});
	});

	it("orders objects inside arrays by the element at the same place", () => {
		const local = json({ list: [{ id: 1, name: "x" }] });
		const remote = json({ list: [{ name: "y", id: 1 }, { z: 0 }] });

		expect(alignJsonSides(local, local, remote)?.remote).toBe(
			json({ list: [{ id: 1, name: "y" }, { z: 0 }] }),
		);
	});

	it.each([
		["text that is not JSON", "{ nope"],
		["hand formatting", '{"a": 1, "b": 2}'],
		["a big integer", '{"a": 12345678901234567890}'],
		["a number form parsing rewrites", '{\n  "a": 1.0\n}'],
	])("refuses %s on any side", (_, odd) => {
		const plain = json({ a: 1, b: 2 });

		expect(alignJsonSides(odd, plain, plain)).toBeNull();
		expect(alignJsonSides(plain, odd, plain)).toBeNull();
		expect(alignJsonSides(plain, plain, odd)).toBeNull();
	});

	it("keeps a __proto__ key as a key", () => {
		const local = '{\n  "__proto__": 1,\n  "a": 2\n}';
		const remote = '{\n  "a": 2,\n  "__proto__": 3\n}';

		expect(alignJsonSides(local, local, remote)?.remote).toBe(
			'{\n  "__proto__": 3,\n  "a": 2\n}',
		);
	});
});
