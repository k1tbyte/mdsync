import { describe, expect, it } from "vitest";

import {
	isAtNote,
	mergePeople,
	onePerPerson,
	type Person,
} from "@/presence/views";

const ALEX: Person = {
	key: "p1",
	name: "Alex",
	devices: [],
	note: "a.md",
	idle: false,
};

describe("people views", () => {
	it("count someone as at a note only while they have one open and are not away", () => {
		expect(isAtNote(ALEX)).toBe(true);
		expect(isAtNote({ ...ALEX, idle: true })).toBe(false);
		expect(isAtNote({ ...ALEX, note: null })).toBe(false);
	});

	it("merge people by key, away only while every device of theirs is", () => {
		const away = { ...ALEX, idle: true };

		expect(mergePeople([ALEX], [away])).toEqual([ALEX]);
		expect(mergePeople([away], [{ ...away, note: "b.md" }])).toEqual([
			{ ...away, note: "b.md" },
		]);
		expect(mergePeople([away], [ALEX])).toEqual([ALEX]);
	});

	it("gather one person's devices under their one entry", () => {
		const phone = { ...ALEX, devices: ["Phone"], note: null };
		const laptop = { ...ALEX, devices: ["Laptop"] };

		expect(onePerPerson([phone, laptop])).toEqual([
			{ ...laptop, devices: ["Laptop", "Phone"] },
		]);
		expect(mergePeople([laptop], [phone])[0]?.devices).toEqual([
			"Laptop",
			"Phone",
		]);
	});
});
