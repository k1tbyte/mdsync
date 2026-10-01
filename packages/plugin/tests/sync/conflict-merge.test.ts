import { describe, expect, it } from "vitest";
import { toLines } from "@/sync/merge-model";

describe("line helpers", () => {
	it("splits on LF after folding CRLF", () => {
		expect(toLines("a\r\nb\nc")).toEqual(["a", "b", "c"]);
	});
});
