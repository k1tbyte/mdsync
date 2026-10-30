import { describe, expect, it } from "vitest";
import { stepIndex } from "@/features/diff/rail";

describe("stepIndex", () => {
	it("starts at the first going forward and at the last going back", () => {
		expect(stepIndex(-1, 1, 3)).toBe(0);
		expect(stepIndex(-1, -1, 3)).toBe(2);
	});

	it("wraps round both ways", () => {
		expect(stepIndex(2, 1, 3)).toBe(0);
		expect(stepIndex(0, -1, 3)).toBe(2);
	});

	it("has nowhere to go without changes", () => {
		expect(stepIndex(-1, 1, 0)).toBe(-1);
	});
});
