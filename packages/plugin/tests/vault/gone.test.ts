import type { DataAdapter } from "obsidian";
import { describe, expect, it } from "vitest";

import { confirmGone } from "@/vault/gone";

type Listing = { files?: string[]; folders?: string[] };

/** A disk that answers `list` only for the folders given; any other throws as ENOENT would. */
function disk(listings: Record<string, Listing>) {
	const calls: string[] = [];
	const adapter = {
		list: async (dir: string) => {
			calls.push(dir);
			const listing = listings[dir];
			if (!listing) throw new Error(`ENOENT: ${dir}`);
			return { files: listing.files ?? [], folders: listing.folders ?? [] };
		},
	} as unknown as DataAdapter;
	return { adapter, calls };
}

describe("confirmGone", () => {
	it("confirms a file its folder no longer lists", async () => {
		const { adapter } = disk({ "": { folders: ["notes"] }, notes: {} });
		expect(await confirmGone(adapter, ["notes/a.md"])).toEqual(
			new Set(["notes/a.md"]),
		);
	});

	it("keeps a file its folder still lists, whatever stat said", async () => {
		const { adapter } = disk({ notes: { files: ["notes/a.md"] } });
		expect(await confirmGone(adapter, ["notes/a.md"])).toEqual(new Set());
	});

	it("keeps the files of a folder that cannot be listed while its parent still names it", async () => {
		const { adapter } = disk({ "": { folders: ["notes"] } });
		expect(
			await confirmGone(adapter, ["notes/a.md", "notes/sub/b.md"]),
		).toEqual(new Set());
	});

	it("confirms a deleted folder's files from the nearest folder that lists", async () => {
		const { adapter } = disk({ "": { folders: ["other"] } });
		expect(await confirmGone(adapter, ["notes/sub/a.md"])).toEqual(
			new Set(["notes/sub/a.md"]),
		);
	});

	it("confirms nothing when not even the vault root lists", async () => {
		const { adapter } = disk({});
		expect(await confirmGone(adapter, ["a.md", "notes/b.md"])).toEqual(
			new Set(),
		);
	});

	it("keeps a path its folder lists in another casing on a case-blind disk", async () => {
		const { adapter } = disk({
			"": { folders: ["Notes"], files: ["readme.md"] },
		});
		expect(await confirmGone(adapter, ["notes/a.md", "README.md"])).toEqual(
			new Set(),
		);
	});

	it("reads a file now a folder of the same name as gone", async () => {
		const { adapter } = disk({ "": { folders: ["a.md"] } });
		expect(await confirmGone(adapter, ["a.md"])).toEqual(new Set(["a.md"]));
	});

	it("lists each folder once however many paths it holds", async () => {
		const { adapter, calls } = disk({ "": {} });
		const paths = ["notes/a.md", "notes/b.md", "notes/c.md"];
		expect(await confirmGone(adapter, paths)).toEqual(new Set(paths));
		expect(calls).toEqual(["notes", ""]);
	});
});
