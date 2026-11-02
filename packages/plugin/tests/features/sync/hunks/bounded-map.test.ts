import { describe, expect, it } from "vitest";
import { trimOldest } from "@/features/sync/hunks/bounded-map";

describe("trimOldest", () => {
	it("drops the oldest until the weight fits", () => {
		const map = new Map([
			["a", 3],
			["b", 3],
			["c", 3],
		]);
		trimOldest(map, 6, (v) => v);
		expect([...map.keys()]).toEqual(["b", "c"]);
	});

	it("keeps the newest even alone over the bound", () => {
		const map = new Map([
			["a", 1],
			["b", 10],
		]);
		trimOldest(map, 5, (v) => v);
		expect([...map.keys()]).toEqual(["b"]);
	});

	it("bounds the count too", () => {
		const map = new Map([
			["a", 1],
			["b", 1],
			["c", 1],
		]);
		trimOldest(map, 100, (v) => v, 2);
		expect([...map.keys()]).toEqual(["b", "c"]);
	});

	it("counts entries without a weight", () => {
		const map = new Map([
			["a", 0],
			["b", 0],
		]);
		trimOldest(map, 1);
		expect([...map.keys()]).toEqual(["b"]);
	});
});
