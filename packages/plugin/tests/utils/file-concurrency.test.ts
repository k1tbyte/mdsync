import { describe, expect, it } from "vitest";

import {
	LARGE_FILE_BYTES,
	runWithFileConcurrency,
} from "@/utils/file-concurrency";

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("file transfer admission", () => {
	it("serializes full large-file pipelines while retaining small-file concurrency", async () => {
		const sizes = [
			LARGE_FILE_BYTES,
			1,
			LARGE_FILE_BYTES,
			1,
			LARGE_FILE_BYTES,
			LARGE_FILE_BYTES,
		];
		let large = 0;
		let all = 0;
		let peakLarge = 0;
		let peakAll = 0;
		await runWithFileConcurrency(
			sizes,
			4,
			(size) => size,
			async (size) => {
				peakAll = Math.max(peakAll, ++all);
				if (size >= LARGE_FILE_BYTES) peakLarge = Math.max(peakLarge, ++large);
				await pause();
				await pause();
				all--;
				if (size >= LARGE_FILE_BYTES) large--;
			},
		);
		expect(peakLarge).toBe(1);
		expect(peakAll).toBeGreaterThan(1);
		expect(peakAll).toBeLessThanOrEqual(4);
	});

	it("does not start large files waiting for admission after cancellation", async () => {
		const aborter = new AbortController();
		const handled: number[] = [];
		await runWithFileConcurrency(
			[0, 1, 2, 3],
			4,
			() => LARGE_FILE_BYTES,
			async (item) => {
				handled.push(item);
				aborter.abort();
			},
			aborter.signal,
		);
		expect(handled).toEqual([0]);
	});

	it("releases the gate on failure without starting new work", async () => {
		const handled: number[] = [];
		await expect(
			runWithFileConcurrency(
				[0, 1, 2, 3, 4],
				2,
				() => LARGE_FILE_BYTES,
				async (item) => {
					handled.push(item);
					throw new Error("transfer failed");
				},
			),
		).rejects.toThrow("transfer failed");
		expect(handled).toEqual([0]);
	});
});
