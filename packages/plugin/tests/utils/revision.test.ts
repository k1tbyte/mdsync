import { describe, expect, it } from "vitest";

import { isNewer } from "@/utils/revision";

describe("isNewer", () => {
	it("lets the higher revision win, then the larger author", () => {
		expect(isNewer({ rev: 2, author: "a" }, { rev: 1, author: "z" })).toBe(
			true,
		);
		expect(isNewer({ rev: 1, author: "b" }, { rev: 1, author: "a" })).toBe(
			true,
		);
		expect(isNewer({ rev: 1, author: "a" }, { rev: 1, author: "a" })).toBe(
			false,
		);
	});
});
