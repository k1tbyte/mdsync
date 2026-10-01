import { describe, expect, it } from "vitest";
import { bytesToText, isLikelyText, textToBytes } from "@/sync/content";

const LATIN1_CAFE = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
const BOM_NOTE = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]);

describe("text classification", () => {
	it("refuses bytes that are not valid UTF-8", () => {
		expect(isLikelyText(LATIN1_CAFE)).toBe(false);
	});

	it("refuses bytes with a NUL", () => {
		expect(isLikelyText(new Uint8Array([0x61, 0, 0x62]))).toBe(false);
	});

	it("accepts UTF-8 text, an empty file and a BOM", () => {
		expect(isLikelyText(textToBytes("héllo ✓"))).toBe(true);
		expect(isLikelyText(new Uint8Array())).toBe(true);
		expect(isLikelyText(BOM_NOTE)).toBe(true);
	});

	it("round-trips a BOM note byte for byte", () => {
		expect(textToBytes(bytesToText(BOM_NOTE))).toEqual(BOM_NOTE);
	});
});
