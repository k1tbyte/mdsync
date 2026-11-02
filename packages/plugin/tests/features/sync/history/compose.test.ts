import { seeded } from "@tests/helpers/seeded";
import { describe, expect, it } from "vitest";
import {
	changeEntries,
	composeChanges,
	diffManifests,
	historyTracks,
	splitTracked,
	undoChanges,
	untrackedDir,
} from "@/features/sync/history/changes";
import type { SnapshotChanges } from "@/features/sync/history/types";
import type { EFileKind, Manifest, ManifestEntry } from "@/features/sync/types";

function entry(hash: string, mtime = 1): ManifestEntry {
	return { hash, size: hash.length, mtime, kind: "vault" as EFileKind };
}

function manifest(files: Record<string, ManifestEntry>): Manifest {
	return {
		version: 1,
		vaultId: "v",
		snapshotId: "s",
		parentSnapshotId: null,
		createdAt: 1,
		deviceId: "d",
		files,
	};
}

function changes(partial: Partial<SnapshotChanges>): SnapshotChanges {
	return { added: {}, modified: {}, deleted: {}, ...partial };
}

const a = entry("a");
const b = entry("b");
const c = entry("c");

describe("composeChanges", () => {
	it("keeps the last content of a file added in the run", () => {
		const merged = composeChanges([
			changes({ added: { n: a } }),
			changes({ modified: { n: { from: a, to: b } } }),
		]);
		expect(merged).toEqual(changes({ added: { n: b } }));
	});

	it("leaves no trace of a file added and deleted in the run", () => {
		const merged = composeChanges([
			changes({ added: { n: a } }),
			changes({ deleted: { n: a } }),
		]);
		expect(merged).toEqual(changes({}));
	});

	it("chains edits and drops a file edited back to where it started", () => {
		expect(
			composeChanges([
				changes({ modified: { n: { from: a, to: b } } }),
				changes({ modified: { n: { from: b, to: c } } }),
			]),
		).toEqual(changes({ modified: { n: { from: a, to: c } } }));
		expect(
			composeChanges([
				changes({ modified: { n: { from: a, to: b } } }),
				changes({ modified: { n: { from: b, to: a } } }),
			]),
		).toEqual(changes({}));
	});

	it("keeps the content right before a deletion apart from the parent's", () => {
		const merged = composeChanges([
			changes({ modified: { n: { from: a, to: b } } }),
			changes({ deleted: { n: b } }),
		]);
		expect(merged).toEqual(
			changes({ deleted: { n: a }, deletedLast: { n: b } }),
		);
	});

	it("turns a deletion and a new file at the path into an edit", () => {
		const merged = composeChanges([
			changes({ deleted: { n: a }, deletedLast: { n: b } }),
			changes({ added: { n: c } }),
		]);
		expect(merged).toEqual(changes({ modified: { n: { from: a, to: c } } }));
	});

	it("reads a path named like an Object member as a path", () => {
		const merged = composeChanges([
			changes({ added: { toString: a } }),
			changes({ modified: { toString: { from: a, to: b } } }),
		]);
		expect(merged).toEqual(changes({ added: { toString: b } }));
	});

	it("counts the content before a merged deletion as reachable", () => {
		const merged = changes({ deleted: { n: a }, deletedLast: { n: b } });
		expect(changeEntries(merged).map((e) => e.hash)).toEqual(["a", "b"]);
	});
});

describe("splitTracked", () => {
	const tracks = historyTracks(".obsidian");

	it("keeps vault paths and releases every hash the config folder names, once", () => {
		const split = splitTracked(
			changes({
				added: { "n.md": a, ".obsidian/new.json": b },
				modified: {
					"m.md": { from: a, to: b },
					".obsidian/app.json": { from: b, to: c },
				},
				deleted: { "d.md": a, ".obsidian/old.json": c },
			}),
			tracks,
		);

		expect(split.changes).toEqual(
			changes({
				added: { "n.md": a },
				modified: { "m.md": { from: a, to: b } },
				deleted: { "d.md": a },
			}),
		);
		// b is named twice and c twice on the untracked side, and a only by vault paths.
		expect([...split.released].sort()).toEqual(["b", "c"]);
	});

	it("releases nothing when no path is left out", () => {
		const all = changes({ added: { "n.md": a }, deleted: { "d.md": b } });
		expect(splitTracked(all, tracks)).toEqual({ changes: all, released: [] });
	});
});

describe("historyTracks", () => {
	it("tracks every path without a configuration folder", () => {
		const tracks = historyTracks(undefined);
		expect(tracks(".obsidian/app.json")).toBe(true);
		expect(tracks("n.md")).toBe(true);
	});

	it("leaves out only what sits under the folder itself", () => {
		const tracks = historyTracks(".obsidian");
		expect(tracks(".obsidian/plugins/x/main.js")).toBe(false);
		expect(tracks(".obsidian-other/x")).toBe(true);
		expect(tracks("notes/.obsidian/x")).toBe(true);
	});

	it("leaves out the folder in any casing, as a case-blind disk holds one", () => {
		expect(historyTracks(".obsidian")(".Obsidian/app.json")).toBe(false);
	});

	it("leaves out only the vault's folder: a share's scope names it too", () => {
		const scope = { configDir: ".obsidian" };
		expect(untrackedDir({ space: { root: "" }, scope })).toBe(".obsidian");
		expect(untrackedDir({ space: { root: "Shared" }, scope })).toBeUndefined();
	});
});

/** Few paths and few contents, so files come and go and edits land back where they started. */
function chain(seed: number, steps: number): Manifest[] {
	const random = seeded(seed);
	const pick = <T>(items: readonly T[]): T =>
		items[Math.floor(random() * items.length)] as T;
	const pool = ["x", "y", "z"].flatMap((hash) => [
		entry(hash, 1),
		entry(hash, 2),
	]);
	const paths = ["a.md", "b.md", "c.md", "d/e.md", "toString"];
	const manifests = [manifest({})];
	for (let step = 0; step < steps; step++) {
		const files = { ...manifests.at(-1)?.files };
		for (const path of paths) {
			const roll = random();
			if (roll < 0.2) delete files[path];
			else if (roll < 0.55) files[path] = pick(pool);
		}
		manifests.push(manifest(files));
	}
	return manifests;
}

describe("composeChanges over generated chains", () => {
	it("replays a merged run to its first parent and forward to its end", () => {
		for (let seed = 1; seed <= 60; seed++) {
			const manifests = chain(seed, 12);
			const random = seeded(seed * 7);
			let start = 0;
			while (start < manifests.length - 1) {
				const end = Math.min(
					manifests.length - 1,
					start + 1 + Math.floor(random() * 5),
				);
				const run = manifests
					.slice(start + 1, end + 1)
					.map((next, index) =>
						diffManifests(manifests[start + index] ?? null, next),
					);
				const merged = composeChanges(run);
				const from = manifests[start] as Manifest;
				const to = manifests[end] as Manifest;

				const back = { ...to.files };
				undoChanges(back, merged);
				expect(back).toEqual(from.files);
				expect(diffManifests(from, to)).toEqual({
					added: merged.added,
					modified: merged.modified,
					deleted: merged.deleted,
				});

				for (const path of Object.keys(merged.deleted)) {
					const lastSeen = manifests
						.slice(start, end)
						.reverse()
						.find((m) => Object.hasOwn(m.files, path))?.files[path];
					const last = merged.deletedLast ?? {};
					expect(
						Object.hasOwn(last, path) ? last[path] : merged.deleted[path],
					).toBe(lastSeen);
				}
				const named = new Set(run.flatMap(changeEntries));
				for (const version of changeEntries(merged)) {
					expect(named.has(version)).toBe(true);
				}
				start = end;
			}
		}
	});
});
