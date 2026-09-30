import { describe, expect, it } from "vitest";

import { personColor, personTint } from "@/shared/colors";

describe("person colours", () => {
	it("are hex, so y-codemirror's own tint of a cursor matches the tint of their text", () => {
		for (const key of ["d1", "laptop", "Anna", ""]) {
			expect(personColor(key)).toMatch(/^#[0-9a-f]{6}$/);
			expect(personTint(key)).toBe(`${personColor(key)}33`);
		}
	});
});
