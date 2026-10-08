import { describe, expect, it } from "vitest";
import {
	isLinkRecord,
	type LinkRecord,
	onRelay,
	renamedLinks,
} from "@/links/record";

const record: LinkRecord = {
	id: "abcdefghijklmnopqrstuv",
	url: "https://relay.example/s/abcdefghijklmnopqrstuv#key",
	path: "a/b/note.md",
	title: "Note",
	createdAt: 1_760_000_000_000,
	publishedAt: 1_760_000_000_000,
	expires: null,
	maxViews: null,
	salt: null,
	images: true,
};

const relay = { relayUrl: "https://relay.example", relaySecret: "secret" };

describe("isLinkRecord", () => {
	it.each([
		record,
		{ ...record, expires: 2_000_000_000, maxViews: 5, salt: "salt" },
		{ ...record, title: "", images: false },
	])("accepts a complete record %#", (value) => {
		expect(isLinkRecord(value)).toBe(true);
	});

	it.each([null, undefined, "link", 42, true, [], {}])(
		"rejects a non-record %#",
		(value) => {
			expect(isLinkRecord(value)).toBe(false);
		},
	);

	it.each([
		["id", 1],
		["url", null],
		["path", false],
		["title", 1],
		["createdAt", "today"],
		["expires", "never"],
		["maxViews", "unlimited"],
		["salt", 1],
		["images", "yes"],
	] as const)("rejects an invalid %s", (field, value) => {
		expect(isLinkRecord({ ...record, [field]: value })).toBe(false);
	});

	it("requires every field, including nullable fields", () => {
		for (const field of Object.keys(record)) {
			const incomplete = { ...record };
			Reflect.deleteProperty(incomplete, field);
			expect(isLinkRecord(incomplete), field).toBe(false);
		}
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
