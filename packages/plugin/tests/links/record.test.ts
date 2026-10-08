import { describe, expect, it } from "vitest";
import {
	detachedLinks,
	type LinkRecord,
	noteName,
	onRelay,
	parseLinkRecord,
	renamedLinks,
} from "@/links/record";

const record: LinkRecord = {
	id: "abcdefghijklmnopqrstuv",
	url: "https://relay.example/s/abcdefghijklmnopqrstuv#key",
	path: "a/b/note.md",
	showTitle: true,
	detached: false,
	createdAt: 1_760_000_000_000,
	publishedAt: 1_760_000_000_000,
	expires: null,
	maxViews: null,
	salt: null,
	images: true,
};

const relay = { relayUrl: "https://relay.example", relaySecret: "secret" };

describe("parseLinkRecord", () => {
	it.each([
		record,
		{ ...record, expires: 2_000_000_000, maxViews: 5, salt: "salt" },
		{ ...record, showTitle: false, images: false, detached: true },
	])("keeps a complete record %#", (value) => {
		expect(parseLinkRecord(value)).toEqual(value);
	});

	it.each([
		null,
		undefined,
		"link",
		42,
		true,
		[],
		{},
		{ id: "id" },
		{ url: "url" },
		{ id: 1, url: "url" },
		{ id: "id", url: null },
	])("drops a value without a string id and url %#", (value) => {
		expect(parseLinkRecord(value)).toBeNull();
	});

	it.each([
		[{ title: "" }, false],
		[{ title: "Trip" }, true],
		[{ title: "", showTitle: true }, true],
		[{ title: "Trip", showTitle: false }, false],
	] as const)(
		"migrates the original title choice, with an explicit showTitle winning %#",
		(choice, showTitle) => {
			const { showTitle: _showTitle, ...original } = record;
			expect(parseLinkRecord({ ...original, ...choice })?.showTitle).toBe(
				showTitle,
			);
		},
	);

	it("repairs an incomplete record without losing its address", () => {
		expect(parseLinkRecord({ id: record.id, url: record.url })).toEqual({
			...record,
			path: "",
			detached: true,
			createdAt: 0,
			publishedAt: 0,
		});
	});

	it.each([
		["path", false, { path: "", detached: true }],
		["showTitle", 1, { showTitle: true }],
		["createdAt", "today", { createdAt: 0 }],
		["publishedAt", "today", { publishedAt: 0 }],
		["expires", "never", { expires: null }],
		["maxViews", "unlimited", { maxViews: null }],
		["salt", 1, { salt: null }],
		["images", "yes", { images: true }],
		["detached", "yes", { detached: false }],
	] as const)("repairs an invalid %s", (field, value, repaired) => {
		expect(parseLinkRecord({ ...record, [field]: value })).toEqual({
			...record,
			...repaired,
		});
	});

	it("only requires id and url", () => {
		for (const field of Object.keys(record)) {
			const incomplete = { ...record };
			Reflect.deleteProperty(incomplete, field);
			if (field === "id" || field === "url") {
				expect(parseLinkRecord(incomplete), field).toBeNull();
			} else {
				expect(parseLinkRecord(incomplete), field).toMatchObject({
					id: record.id,
					url: record.url,
				});
			}
		}
	});
});

describe("detachedLinks", () => {
	it("detaches an exact note and its folder without touching shared prefixes", () => {
		const nested = { ...record, id: "nested", path: "a/b/sub/note.md" };
		const other = { ...record, id: "other", path: "a/bc/note.md" };
		expect(detachedLinks([record], record.path)).toEqual([
			{ ...record, detached: true },
		]);
		expect(detachedLinks([record, nested, other], "a/b")).toEqual([
			{ ...record, detached: true },
			{ ...nested, detached: true },
			other,
		]);
		expect(record.detached).toBe(false);
	});

	it("skips already detached records on detaches and renames", () => {
		const detached = { ...record, detached: true };
		expect(detachedLinks([detached], "a/b")).toBeNull();
		expect(renamedLinks([detached], "a/b", "moved")).toBeNull();
		expect(detachedLinks([record, detached], "a/b")?.[1]).toBe(detached);
		expect(renamedLinks([record, detached], "a/b", "moved")?.[1]).toBe(
			detached,
		);
		expect(detachedLinks([record], "elsewhere")).toBeNull();
	});
});

describe("noteName", () => {
	it("uses the last known filename without its markdown extension", () => {
		expect(noteName(record)).toBe("note");
		expect(noteName({ ...record, path: "moved/Trip.md", detached: true })).toBe(
			"Trip",
		);
	});
});

describe("renamedLinks", () => {
	it("moves an exact note path and keeps every other field", () => {
		const next = renamedLinks([record], record.path, "moved.md");

		expect(next).toEqual([{ ...record, path: "moved.md" }]);
		expect(record.path).toBe("a/b/note.md");
	});

	it("moves a folder and all nested note paths", () => {
		const nested = { ...record, id: "nested", path: "a/b/sub/note.md" };

		expect(renamedLinks([record, nested], "a/b", "x/y")).toEqual([
			{ ...record, path: "x/y/note.md" },
			{ ...nested, path: "x/y/sub/note.md" },
		]);
	});

	it("does not mistake a shared prefix for a folder boundary", () => {
		const unrelated = { ...record, id: "other", path: "a/bc/note.md" };
		const next = renamedLinks([record, unrelated], "a/b", "moved");

		expect(next).toEqual([{ ...record, path: "moved/note.md" }, unrelated]);
		expect(next?.[1]).toBe(unrelated);
		expect(renamedLinks([unrelated], "a/b", "moved")).toBeNull();
	});

	it("returns null when nothing moved", () => {
		expect(renamedLinks([record], "elsewhere", "moved")).toBeNull();
		expect(renamedLinks([], "a/b", "moved")).toBeNull();
	});
});

describe("onRelay", () => {
	it.each([relay.relayUrl, `${relay.relayUrl}/`])(
		"accepts the same origin at %s",
		(relayUrl) => {
			expect(onRelay(record, { ...relay, relayUrl })).toBe(true);
		},
	);

	it("rejects another origin", () => {
		expect(
			onRelay(record, { ...relay, relayUrl: "https://other.example" }),
		).toBe(false);
	});

	it.each([
		{ ...relay, relayUrl: "" },
		{ ...relay, relaySecret: "" },
		{ ...relay, relayUrl: "not a URL" },
	])("rejects missing or invalid relay settings %#", (settings) => {
		expect(onRelay(record, settings)).toBe(false);
	});

	it("rejects an invalid record URL", () => {
		expect(onRelay({ ...record, url: "not a URL" }, relay)).toBe(false);
	});
});
