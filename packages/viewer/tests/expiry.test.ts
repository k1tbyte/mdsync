import { describe, expect, it } from "vitest";

import { expiryText } from "../src/expiry";

const NOW = Date.UTC(2026, 9, 8, 12, 0);
const at = (ms: number) => Math.floor((NOW + ms) / 1000);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("expiryText", () => {
	it.each([
		[5 * MINUTE, "Expires in 5 min."],
		[4 * MINUTE + 1000, "Expires in 5 min."],
		[59 * MINUTE, "Expires in 59 min."],
		[HOUR, "Expires in 1 hour."],
		[5 * HOUR + 20 * MINUTE, "Expires in 5 hours."],
		[23 * HOUR, "Expires in 23 hours."],
	])("counts %i ms down in minutes, then hours", (ms, text) => {
		expect(expiryText(at(ms), NOW)).toBe(text);
	});

	it("says when it has expired", () => {
		expect(expiryText(at(0), NOW)).toContain("Expired.");
		expect(expiryText(at(-HOUR), NOW)).toContain("Expired.");
	});

	it("names the date a day or more away, the year only when it differs", () => {
		const options = {
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
		} as const;
		const soon = at(3 * 24 * HOUR);
		expect(expiryText(soon, NOW)).toBe(
			`Expires ${new Date(soon * 1000).toLocaleString(undefined, options)}.`,
		);
		const next = at(200 * 24 * HOUR);
		expect(expiryText(next, NOW)).toBe(
			`Expires ${new Date(next * 1000).toLocaleString(undefined, { ...options, year: "numeric" })}.`,
		);
	});
});
