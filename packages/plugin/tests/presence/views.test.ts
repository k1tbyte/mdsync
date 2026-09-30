import { describe, expect, it } from "vitest";

import { isAtNote, mergePeople, type Person } from "@/presence/views";

const ALEX: Person = { key: "p1", name: "Alex", note: "a.md", idle: false };

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
});
