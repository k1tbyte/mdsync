import { CHANNEL_DOC, type ClientFrame, EFrame } from "@mdsync/protocol";
import { describe, expect, it } from "vitest";

import { FrameLimits } from "../../src/hub/limits";

const awareness = (size = 1): ClientFrame => ({
	type: EFrame.Awareness,
	slot: 0,
	doc: CHANNEL_DOC,
	payload: new Uint8Array(size),
});
const update: ClientFrame = {
	type: EFrame.Update,
	n: 1,
	slot: 0,
	doc: "d",
	payload: Uint8Array.of(1),
};
const signal: ClientFrame = { type: EFrame.Signal, slot: 0, doc: CHANNEL_DOC };

function passed(
	limits: FrameLimits,
	tag: number,
	now: number,
	count: number,
	frame: ClientFrame,
	readOnly = false,
): number {
	return Array.from({ length: count }).filter(() =>
		limits.allows(tag, frame, readOnly, 16, now),
	).length;
}

describe("frame limits", () => {
	it("refills the frame ceiling over time, per socket", () => {
		const limits = new FrameLimits();

		expect(passed(limits, 1, 0, 300, update)).toBe(256);
		expect(passed(limits, 2, 0, 1, update)).toBe(1);
		expect(passed(limits, 1, 1_000, 300, update)).toBe(32);
		limits.forget(1);
		expect(passed(limits, 1, 1_000, 300, update)).toBe(256);
	});

	it("keeps a read-only grant's awareness under its own ceiling, whatever else it sends", () => {
		const limits = new FrameLimits();

		expect(passed(limits, 1, 0, 60, awareness(), true)).toBe(40);
		expect(passed(limits, 1, 1_000, 60, awareness(), true)).toBe(20);
		expect(passed(limits, 2, 0, 60, awareness())).toBe(60);
	});

	it("drops a read-only grant's signals and oversized awareness", () => {
		const limits = new FrameLimits();

		expect(limits.allows(1, signal, true, 16)).toBe(false);
		expect(limits.allows(1, awareness(), true, 8 * 1024)).toBe(false);
		expect(limits.allows(1, signal, false, 16)).toBe(true);
	});

	it("lets a read-only grant's writes through for the document handlers to refuse", () => {
		expect(new FrameLimits().allows(1, update, true, 16)).toBe(true);
	});
});
