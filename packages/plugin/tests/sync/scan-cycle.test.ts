import { describe, expect, it, vi } from "vitest";

import { ScanCycle } from "@/sync/runtime/scan-cycle";
import { VAULT_SPACE } from "@/sync/space";
import type { HashCacheEntry } from "@/sync/types";

const entry: HashCacheEntry = { hash: "h", size: 1, mtime: 1 };

describe("partitioned refresh scan", () => {
	it("enumerates 20,000 indexed files once across eleven spaces", () => {
		const spaces = [
			VAULT_SPACE,
			...Array.from({ length: 10 }, (_, index) => ({
				id: `s${index}`,
				root: `Team${index}`,
			})),
		];
		const files = Array.from({ length: 20_000 }, (_, index) => ({
			path:
				index < 10_000 ? `Notes/${index}.md` : `Team${index % 10}/${index}.md`,
			size: 1,
			mtime: 1,
		}));
		const source = {
			configDir: ".obsidian",
			files: vi.fn(() => files),
			folders: vi.fn(() => []),
			rename: async () => false,
		};
		const cache = Object.fromEntries(files.map(({ path }) => [path, entry]));
		const cycle = new ScanCycle(spaces, cache);
		let enumerated = 0;
		for (const space of spaces) {
			const rows = cycle.indexFor(space, source)?.files() ?? [];
			enumerated += rows.length;
			expect(Object.keys(cycle.hashesFor(space))).toEqual(
				rows.map(({ path }) => path),
			);
		}
		expect(enumerated).toBe(20_000);
		expect(source.files).toHaveBeenCalledOnce();
		expect(source.folders).toHaveBeenCalledOnce();
	});

	it("keeps nested and paused shares' hashes when the vault or a parent share prunes its cache", () => {
		const parent = { id: "parent", root: "Team" };
		const nested = { id: "nested", root: "Team/Nested", paused: true as const };
		const cycle = new ScanCycle([VAULT_SPACE, parent, nested], {
			"a.md": entry,
			"Team/a.md": entry,
			"Team/Nested/a.md": entry,
		});
		cycle.update(VAULT_SPACE, {});
		cycle.update(parent, { "Team/new.md": entry });
		expect(cycle.cache).toEqual({
			"Team/new.md": entry,
			"Team/Nested/a.md": entry,
		});
	});
});
