import { afterEach, describe, expect, it } from "vitest";
import {
	formatBytes,
	formatDayLabel,
	pluralize,
	startOfWeek,
	withDevices,
} from "@/core/shared/format";

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
		expect(pluralize(2, "push", "pushes")).toBe("2 pushes");
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

	it("dates the rest by weekday and date, with the year only when it differs", () => {
		const short = { weekday: "short", day: "numeric", month: "short" } as const;
		const old = day(10);
		expect(formatDayLabel(old, noon)).toBe(
			new Date(old).toLocaleDateString(undefined, short),
		);
		const lastYear = day(200);
		expect(formatDayLabel(lastYear, noon)).toBe(
			new Date(lastYear).toLocaleDateString(undefined, {
				...short,
				year: "numeric",
			}),
		);
	});

	it("treats a clock skew into the future as today", () => {
		expect(formatDayLabel(day(-1), noon)).toBe("Today");
	});
});

describe("startOfWeek", () => {
	const zone = process.env.TZ;
	afterEach(() => {
		if (zone === undefined) delete process.env.TZ;
		else process.env.TZ = zone;
	});

	it("lands on Monday's midnight, also from a Sunday whose midnight was skipped", () => {
		process.env.TZ = "America/Santiago";
		const monday = new Date(2026, 7, 31).getTime();
		expect(startOfWeek(new Date(2026, 8, 6, 12).getTime())).toBe(monday);
		expect(startOfWeek(new Date(2026, 7, 31, 23).getTime())).toBe(monday);
		expect(new Date(monday).getHours()).toBe(0);
	});
});
