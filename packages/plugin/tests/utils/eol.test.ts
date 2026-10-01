import { describe, expect, it } from "vitest";

import { computeHunks } from "@/sync/hunks";
import { eolOf, toLf, withEolOf } from "@/utils/eol";

describe("line endings", () => {
	it("reads CRLF and a lone CR as the line break CodeMirror sees", () => {
		expect(toLf("a\r\nb\rc\n\r\r\nd")).toBe("a\nb\nc\n\n\nd");
	});

	it("diffs texts that differ only in line endings as unchanged", () => {
		expect(computeHunks("a\rb\r", "a\nb\n").hunks).toEqual([]);
	});
});

describe("line ending of a file", () => {
	it("reports the line ending a file uses", () => {
		expect(eolOf("a\r\nb")).toBe("\r\n");
		expect(eolOf("a\nb")).toBe("\n");
	});

	it("puts a file's own endings back on LF text", () => {
		expect(withEolOf("x\r\ny", "a\nb\n")).toBe("a\r\nb\r\n");
		expect(withEolOf("x\ny", "a\nb\n")).toBe("a\nb\n");
	});
});
