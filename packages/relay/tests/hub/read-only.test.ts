import { CHANNEL_DOC, EFrame } from "@obsync/protocol";
import { describe, expect, it } from "vitest";

import { ReadOnlyLimits } from "../../src/hub/read-only";

const AWARENESS = {
	type: EFrame.Awareness,
	slot: 0,
	doc: CHANNEL_DOC,
	payload: Uint8Array.of(1),
} as const;

describe("read-only limits", () => {
	it("refills the awareness ceiling over time, per socket", () => {
		const limits = new ReadOnlyLimits();
		const passed = (tag: number, now: number, count: number) =>
			Array.from({ length: count }).filter(() =>
				limits.allows(tag, AWARENESS, 16, now),
			).length;

		expect(passed(1, 0, 30)).toBe(20);
		expect(passed(2, 0, 1)).toBe(1);
		expect(passed(1, 1_000, 30)).toBe(5);
		limits.forget(1);
		expect(passed(1, 1_000, 30)).toBe(20);
	});

	it("lets writes through for the document handlers to refuse", () => {
		const update = { ...AWARENESS, type: EFrame.Update, doc: "d" } as const;

		expect(new ReadOnlyLimits().allows(1, update, 16)).toBe(true);
	});
});
