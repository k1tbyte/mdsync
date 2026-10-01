import { describe, expect, it } from "vitest";
import {
	formatBytes,
	formatDayLabel,
	formatSizeDelta,
	pluralize,
	withDevices,
} from "@/shared/format";

describe("withDevices", () => {
	it("names a person's devices after them, and nothing when none is known", () => {
		expect(withDevices("Kit", ["Laptop", "Phone"])).toBe("Kit · Laptop, Phone");
		expect(withDevices("Kit", [])).toBe("Kit");
	});
});

describe("formatBytes", () => {
	it("keeps bytes exact below a kilobyte", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(1023)).toBe("1023 B");
	});

	it("switches units at the boundary", () => {
		expect(formatBytes(1024)).toBe("1.0 KB");
		expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
	});

	it("rolls over instead of printing 1024 KB", () => {
		// 1048525 B is 1023.95 KB, which rounds to 1024.0 at one decimal.
		expect(formatBytes(1_048_525)).toBe("1.0 MB");
	});
});

describe("pluralize", () => {
	it("only pluralises past one", () => {
		expect(pluralize(1, "file")).toBe("1 file");
		expect(pluralize(0, "file")).toBe("0 files");
		expect(pluralize(2, "file")).toBe("2 files");
	});
});

describe("formatSizeDelta", () => {
	it("signs the change in both directions", () => {
		expect(formatSizeDelta(1024)).toBe("+1.0 KB");
		expect(formatSizeDelta(-1024)).toBe("−1.0 KB");
	});

	it("says nothing when nothing moved", () => {
		expect(formatSizeDelta(0)).toBeNull();
	});
});

describe("formatDayLabel", () => {
	const noon = new Date(2024, 4, 15, 12).getTime();
	const day = (offset: number, hour = 12): number =>
		new Date(2024, 4, 15 - offset, hour).getTime();

	it("names the two days that have names", () => {
		expect(formatDayLabel(day(0, 1), noon)).toBe("Today");
		expect(formatDayLabel(day(1, 23), noon)).toBe("Yesterday");
	});

	it("names the weekday for the rest of the week", () => {
		const midweek = day(3);
		expect(formatDayLabel(midweek, noon)).toBe(
			new Date(midweek).toLocaleDateString(undefined, { weekday: "long" }),
		);
	});

	it("falls back to the date once the week is out", () => {
		const old = day(10);
		expect(formatDayLabel(old, noon)).toBe(new Date(old).toLocaleDateString());
	});

	it("treats a clock skew into the future as today", () => {
		expect(formatDayLabel(day(-1), noon)).toBe("Today");
	});
});
