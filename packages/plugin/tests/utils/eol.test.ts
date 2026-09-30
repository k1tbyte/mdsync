import { describe, expect, it } from "vitest";

import { computeHunks } from "@/sync/hunks";
import { toLf } from "@/utils/eol";

describe("line endings", () => {
	it("reads CRLF and a lone CR as the line break CodeMirror sees", () => {
		expect(toLf("a\r\nb\rc\n\r\r\nd")).toBe("a\nb\nc\n\n\nd");
	});

	it("diffs texts that differ only in line endings as unchanged", () => {
		expect(computeHunks("a\rb\r", "a\nb\n").hunks).toEqual([]);
	});
});
