import { describe, expect, it } from "vitest";
import { Backoff } from "@/features/sync/automation/backoff";

const MIN = 60_000;
const T0 = 1_000_000;

function failed(times: number, now = T0): Backoff {
	const backoff = new Backoff();
	for (let i = 0; i < times; i++) backoff.fail(now);
	return backoff;
}

describe("Backoff", () => {
	it("does not block before the third failure", () => {
		const backoff = failed(2);
		expect(backoff.blocks(T0)).toBe(false);
		expect(backoff.blocks(T0 + MIN)).toBe(false);
	});

	it("blocks for 2 minutes from the third failure", () => {
		const backoff = failed(3);
		expect(backoff.blocks(T0)).toBe(true);
		expect(backoff.blocks(T0 + 2 * MIN - 1)).toBe(true);
		expect(backoff.blocks(T0 + 2 * MIN)).toBe(false);
	});

	it("doubles the delay with each further failure", () => {
		for (const [times, minutes] of [
			[4, 4],
			[5, 8],
			[6, 16],
			[7, 32],
		] as const) {
			const backoff = failed(times);
			expect(backoff.blocks(T0 + minutes * MIN - 1)).toBe(true);
			expect(backoff.blocks(T0 + minutes * MIN)).toBe(false);
		}
	});

	it("measures the delay from the failure it was given", () => {
		const backoff = failed(2);
		backoff.fail(T0 + 10 * MIN);
		expect(backoff.blocks(T0 + 12 * MIN - 1)).toBe(true);
		expect(backoff.blocks(T0 + 12 * MIN)).toBe(false);
	});

	it("caps the delay at 60 minutes", () => {
		for (const times of [8, 9, 30]) {
			const backoff = failed(times);
			expect(backoff.blocks(T0 + 60 * MIN - 1)).toBe(true);
			expect(backoff.blocks(T0 + 60 * MIN)).toBe(false);
		}
	});

	it("clears the block and the count on succeed", () => {
		const backoff = failed(5);
		backoff.succeed();
		expect(backoff.blocks(T0)).toBe(false);
		backoff.fail(T0);
		backoff.fail(T0);
		expect(backoff.blocks(T0)).toBe(false);
		backoff.fail(T0);
		expect(backoff.blocks(T0 + 2 * MIN - 1)).toBe(true);
		expect(backoff.blocks(T0 + 2 * MIN)).toBe(false);
	});
});
