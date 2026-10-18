import { describe, expect, it } from "vitest";

import {
	folderName,
	hasDotSegment,
	hasReservedChar,
	normalizeKeyPrefix,
	normalizePath,
} from "@/shared/path";

describe("path normalisation", () => {
	it("strips a leading separator whichever way it leans", () => {
		expect(normalizePath("/notes/a.md")).toBe("notes/a.md");
		expect(normalizePath("\\notes\\a.md")).toBe("notes/a.md");
	});

	it("composes unicode so macOS and Windows agree on one name", () => {
		const decomposed = "café.md";
		const composed = "café.md";
		expect(normalizePath(decomposed)).toBe(normalizePath(composed));
	});

	it("recognises dot segments anywhere in the path", () => {
		expect(hasDotSegment("plugins/foo/.git/config")).toBe(true);
		expect(hasDotSegment("plugins/foo/data.json")).toBe(false);
		expect(hasDotSegment("../escape.md")).toBe(true);
	});

	it("normalises a key prefix to a single trailing slash", () => {
		expect(normalizeKeyPrefix("/vaults/mine/")).toBe("vaults/mine/");
		expect(normalizeKeyPrefix("")).toBe("");
	});
});

describe("folder names", () => {
	it("keep a name to one folder that every platform accepts", () => {
		expect(folderName("Team/2024: plans?")).toBe("Team-2024- plans-");
		expect(folderName("..\\hidden.")).toBe("-hidden");
		expect(folderName(" . ")).toBe("");
		expect(folderName("a\tb")).toBe("a-b");
	});
});

describe("reserved characters", () => {
	it("flag a name Windows or Android cannot create, in any folder", () => {
		expect(hasReservedChar("Icon\r")).toBe(true);
		expect(hasReservedChar("why?/a.md")).toBe(true);
		expect(hasReservedChar('say "hi".md')).toBe(true);
		expect(hasReservedChar("notes/Привет, мир.md")).toBe(false);
		expect(hasReservedChar("del\u007f.md")).toBe(true);
		expect(hasReservedChar("nel\u0085 😀 ~.md")).toBe(false);
	});
});
