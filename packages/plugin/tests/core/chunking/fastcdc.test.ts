import { seeded } from "@tests/helpers/seeded";
import { describe, expect, it } from "vitest";
import { chunkEnds, gearTable } from "@/core/chunking";

const PARAMS = { min: 1024, avg: 4096, max: 16_384 };
const GEAR = gearTable(7);

function noise(length: number, seed: number): Uint8Array {
	const random = seeded(seed);
	return Uint8Array.from({ length }, () => Math.floor(random() * 256));
}

function chunks(bytes: Uint8Array): string[] {
	const out: string[] = [];
	let start = 0;
	for (const end of chunkEnds(bytes, PARAMS, GEAR)) {
		out.push(Array.from(bytes.subarray(start, end)).join(","));
		start = end;
	}
	return out;
}

describe("chunkEnds", () => {
	it("keeps every chunk within bounds, near the average, and ends at the input's end", () => {
		const bytes = noise(400_000, 1);
		const ends = chunkEnds(bytes, PARAMS, GEAR);
		const sizes = ends.map((end, index) => end - (ends[index - 1] ?? 0));
		expect(ends.at(-1)).toBe(bytes.length);
		for (const size of sizes.slice(0, -1)) {
			expect(size).toBeGreaterThanOrEqual(PARAMS.min);
			expect(size).toBeLessThanOrEqual(PARAMS.max);
		}
		const average = bytes.length / sizes.length;
		expect(average).toBeGreaterThan(PARAMS.avg / 2);
		expect(average).toBeLessThan(PARAMS.avg * 2);
	});

	it("cuts the same content the same way, and another gear elsewhere", () => {
		const bytes = noise(100_000, 2);
		expect(chunkEnds(bytes, PARAMS, GEAR)).toEqual(
			chunkEnds(bytes, PARAMS, gearTable(7)),
		);
		expect(chunkEnds(bytes, PARAMS, gearTable(8))).not.toEqual(
			chunkEnds(bytes, PARAMS, GEAR),
		);
	});

	it("changes only the chunks around an insertion", () => {
		const before = noise(200_000, 3);
		const after = new Uint8Array(before.length + 100);
		after.set(before.subarray(0, 100_000));
		after.set(noise(100, 4), 100_000);
		after.set(before.subarray(100_000), 100_100);
		const kept = new Set(chunks(before));
		const fresh = chunks(after).filter((chunk) => !kept.has(chunk));
		expect(fresh.length).toBeLessThanOrEqual(2);
	});

	it("leaves an input up to the minimum whole", () => {
		expect(chunkEnds(noise(1000, 5), PARAMS, GEAR)).toEqual([1000]);
		expect(chunkEnds(new Uint8Array(0), PARAMS, GEAR)).toEqual([]);
	});
});
