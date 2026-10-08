import type { LinkStatus } from "@mdsync/protocol";
import { LINK_MAX_TTL_S } from "@mdsync/protocol";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_EXPIRY,
	EXPIRY_CHOICES,
	expiryLine,
	leftOutText,
	linkStatusText,
	resolveExpiry,
} from "@/links/describe";
import type { LinkRecord } from "@/links/record";

const MS_PER_S = 1000;
const MINUTE_MS = 60 * MS_PER_S;
const DAY_MS = 24 * 60 * MINUTE_MS;
const NOW_MS = new Date("2025-01-15T12:00:00Z").getTime();

function pickedAt(ms: number): string {
	const date = new Date(ms);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const record: LinkRecord = {
	id: "abcdefghijklmnopqrstuv",
	url: "https://relay.example/s/abcdefghijklmnopqrstuv#key",
	path: "note.md",
	showTitle: true,
	detached: false,
	createdAt: 1_760_000_000_000,
	publishedAt: 1_760_000_000_000,
	expires: null,
	maxViews: null,
	salt: null,
	images: true,
};
const status: LinkStatus = {
	views: 2,
	maxViews: null,
	expires: null,
	protected: false,
	size: 123,
};

describe("resolveExpiry", () => {
	it("keeps the week default and the ordered choices", () => {
		expect(DEFAULT_EXPIRY).toBe("week");
		expect(EXPIRY_CHOICES.map(({ key, label }) => [key, label])).toEqual([
			["five-minutes", "5 minutes"],
			["fifteen-minutes", "15 minutes"],
			["hour", "1 hour"],
			["day", "1 day"],
			["week", "7 days"],
			["month", "30 days"],
			["never", "Never"],
			["date", "Pick a date…"],
		]);
	});

	it.each([
		["five-minutes", 300],
		["fifteen-minutes", 900],
		["hour", 3600],
		["day", 86400],
		["week", 604800],
		["month", 2592000],
	])("resolves %s relative to now in unix seconds", (key, seconds) => {
		expect(resolveExpiry(key, "", NOW_MS + 999)).toEqual({
			ok: true,
			ttl: seconds,
			expires: NOW_MS / MS_PER_S + seconds,
		});
	});

	it("resolves never without a date", () => {
		expect(resolveExpiry("never", "", NOW_MS)).toEqual({
			ok: true,
			ttl: null,
			expires: null,
		});
	});

	it("ignores a picked date for presets", () => {
		expect(resolveExpiry("day", "invalid", NOW_MS)).toEqual({
			ok: true,
			ttl: DAY_MS / MS_PER_S,
			expires: (NOW_MS + DAY_MS) / MS_PER_S,
		});
	});

	it.each([MINUTE_MS, DAY_MS, LINK_MAX_TTL_S * MS_PER_S])(
		"accepts a local date %i milliseconds ahead, including the bounds",
		(aheadMs) => {
			expect(resolveExpiry("date", pickedAt(NOW_MS + aheadMs), NOW_MS)).toEqual(
				{
					ok: true,
					ttl: aheadMs / MS_PER_S,
					expires: (NOW_MS + aheadMs) / MS_PER_S,
				},
			);
		},
	);

	it.each([-MINUTE_MS, 0])(
		"rejects a date %i milliseconds ahead",
		(aheadMs) => {
			expect(resolveExpiry("date", pickedAt(NOW_MS + aheadMs), NOW_MS)).toEqual(
				{
					ok: false,
					reason: "Pick a date at least 1 minute ahead.",
				},
			);
		},
	);

	it("rejects a date less than one minute ahead even by one millisecond", () => {
		expect(
			resolveExpiry("date", pickedAt(NOW_MS + MINUTE_MS), NOW_MS + 1),
		).toEqual({ ok: false, reason: "Pick a date at least 1 minute ahead." });
	});

	it("rejects a date beyond the maximum even by one millisecond", () => {
		expect(
			resolveExpiry(
				"date",
				pickedAt(NOW_MS + LINK_MAX_TTL_S * MS_PER_S),
				NOW_MS - 1,
			),
		).toEqual({
			ok: false,
			reason: "Pick a date no more than 365 days ahead.",
		});
	});

	it.each(["", "invalid"])(
		"rejects an empty or invalid picked date: %s",
		(picked) => {
			expect(resolveExpiry("date", picked, NOW_MS)).toEqual({
				ok: false,
				reason: "Pick a date and time.",
			});
		},
	);

	it("floors the picked date span from the current clock", () => {
		expect(
			resolveExpiry("date", pickedAt(NOW_MS + DAY_MS), NOW_MS + 999),
		).toEqual({
			ok: true,
			ttl: DAY_MS / MS_PER_S - 1,
			expires: (NOW_MS + DAY_MS) / MS_PER_S - 1,
		});
		expect(EXPIRY_CHOICES.at(-1)).not.toHaveProperty("seconds");
	});

	it("rejects an unknown choice", () => {
		expect(resolveExpiry("unknown", "", NOW_MS)).toEqual({
			ok: false,
			reason: "Choose an expiry.",
		});
	});
});

describe("expiryLine", () => {
	it("describes a link that never expires", () => {
		expect(expiryLine(null)).toBe("Never expires.");
	});

	it("uses the same locale formatting as the link status", () => {
		const expires = (NOW_MS + DAY_MS) / MS_PER_S;
		const when = new Date(expires * MS_PER_S).toLocaleString(undefined, {
			dateStyle: "medium",
			timeStyle: "short",
		});
		expect(expiryLine(expires)).toBe(`Expires ${when}.`);
		expect(linkStatusText(record, { ...status, expires })).toBe(
			`2 views · expires ${when}`,
		);
	});
});

describe("linkStatusText", () => {
	it("describes a missing link as ended", () => {
		expect(linkStatusText(record, null)).toBe(
			"Ended: it expired, was used up or was stopped.",
		);
	});

	it.each([
		[0, "0 views"],
		[1, "1 view"],
		[2, "2 views"],
	])("describes %i unlimited views", (views, text) => {
		expect(linkStatusText(record, { ...status, views })).toBe(
			`${text} · never expires`,
		);
	});

	it.each([
		[2, 3],
		[5, 0],
		[8, 0],
	])("clamps views left after %i views", (views, left) => {
		expect(linkStatusText(record, { ...status, views, maxViews: 5 })).toBe(
			`${left} of 5 views left · never expires`,
		);
	});

	it("describes a dated expiry without relying on the locale", () => {
		const text = linkStatusText(record, { ...status, expires: 2_000_000_000 });

		expect(text).toContain("expires");
		expect(text).not.toContain("never expires");
	});

	it("adds a passphrase suffix for a salted record", () => {
		expect(linkStatusText({ ...record, salt: "salt" }, status)).toBe(
			"2 views · never expires · passphrase",
		);
	});
});

describe("leftOutText", () => {
	it("returns no text when nothing was left out", () => {
		expect(leftOutText({ embeds: 0, images: 0, diagrams: 0 })).toBe("");
	});

	it("uses singular nouns", () => {
		expect(leftOutText({ embeds: 1, images: 1, diagrams: 1 })).toBe(
			"1 embedded file, 1 image, 1 diagram (shown as text)",
		);
	});

	it("uses plural nouns", () => {
		expect(leftOutText({ embeds: 2, images: 3, diagrams: 4 })).toBe(
			"2 embedded files, 3 images, 4 diagrams (shown as text)",
		);
	});

	it("omits zero counts without leaving separators", () => {
		expect(leftOutText({ embeds: 0, images: 2, diagrams: 0 })).toBe("2 images");
	});
});
