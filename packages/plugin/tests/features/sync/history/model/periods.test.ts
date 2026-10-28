import { seeded } from "@tests/helpers/seeded";
import { describe, expect, it } from "vitest";
import {
	countsBefore,
	dueResolution,
	groupEnd,
	groupStart,
	isDue,
	keepStart,
	keptUntil,
	RESOLUTIONS,
} from "@/features/sync/history/model/periods";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 27, 15, 37, 12);
const QUARTER = 90 * DAY;

describe("history periods", () => {
	it("nests every group inside the next coarser one, and every span inside its group", () => {
		const random = seeded(3);
		for (let i = 0; i < 500; i++) {
			const at = Math.floor(random() * NOW);
			for (const [index, res] of RESOLUTIONS.entries()) {
				const start = groupStart(res, at);
				expect(start).toBeLessThanOrEqual(at);
				expect(groupEnd(res, start)).toBeGreaterThan(at);
				const span = keepStart(res, at);
				if (span !== null) expect(span).toBeGreaterThanOrEqual(start);
				const coarser = RESOLUTIONS[index + 1];
				if (!coarser) continue;
				const outer = groupStart(coarser, at);
				expect(start).toBeGreaterThanOrEqual(outer);
				expect(groupEnd(res, start)).toBeLessThanOrEqual(
					groupEnd(coarser, outer),
				);
			}
		}
	});

	it("starts weeks on Monday at midnight UTC", () => {
		expect(new Date(groupStart("1d", NOW)).toISOString()).toBe(
			"2026-10-26T00:00:00.000Z",
		);
	});

	it("packs a 10-minute slot only 10 minutes after it ends", () => {
		const slot = groupStart("push", NOW);
		const end = groupEnd("push", slot);
		expect(isDue("push", slot, end + 10 * MINUTE - 1, QUARTER)).toBe(false);
		expect(isDue("push", slot, end + 10 * MINUTE, QUARTER)).toBe(true);
	});

	it("never drops to counts when history is kept forever", () => {
		expect(dueResolution(0, NOW, null)).toBe("1w");
		expect(dueResolution(0, NOW, QUARTER)).toBe("counts");
	});

	it("leaves fresh pushes unpacked and thins older ones by age", () => {
		expect(dueResolution(NOW - MINUTE, NOW, QUARTER)).toBeNull();
		expect(dueResolution(NOW - 2 * HOUR, NOW, QUARTER)).toBe("10m");
		expect(dueResolution(NOW - 3 * DAY, NOW, QUARTER)).toBe("1h");
		expect(dueResolution(NOW - 20 * DAY, NOW, QUARTER)).toBe("1d");
		expect(dueResolution(NOW - 70 * DAY, NOW, QUARTER)).toBe("1w");
		expect(dueResolution(NOW - 150 * DAY, NOW, QUARTER)).toBe("counts");
	});

	it("only ever coarsens a record as time passes", () => {
		const random = seeded(9);
		for (let i = 0; i < 200; i++) {
			const at = NOW - Math.floor(random() * 200 * DAY);
			let previous = -1;
			for (let now = at; now < at + 200 * DAY; now += 7 * HOUR) {
				const res = dueResolution(at, now, QUARTER);
				const index = res === null ? -1 : RESOLUTIONS.indexOf(res);
				expect(index).toBeGreaterThanOrEqual(previous);
				previous = index;
			}
		}
	});

	it("puts every record before countsBefore past keptUntil, and none after", () => {
		const cutoff = countsBefore(NOW, QUARTER);
		expect(keptUntil(cutoff - 1, QUARTER)).toBeLessThanOrEqual(NOW);
		expect(keptUntil(cutoff, QUARTER)).toBeGreaterThan(NOW);
	});
});
