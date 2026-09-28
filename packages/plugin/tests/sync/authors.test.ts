import { describe, expect, it } from "vitest";

import { attribute, authorOf, publisher } from "@/sync/authors";
import { EFileKind, type Manifest, type ManifestEntry } from "@/sync/types";

const ALEX = { key: "p1", name: "Alex" };
const SAM = { key: "p2", name: "Sam" };
const GONE = { key: "p3", name: "Gone" };

function entry(hash: string, by?: number): ManifestEntry {
	return { hash, size: 1, mtime: 1, kind: EFileKind.Vault, by };
}

function parent(
	files: Record<string, ManifestEntry>,
	authors = [SAM, GONE],
): Manifest {
	return {
		version: 1,
		vaultId: "v",
		snapshotId: "s",
		parentSnapshotId: null,
		createdAt: 1,
		deviceId: "d",
		deviceName: "d",
		files,
		authors,
	};
}

describe("manifest authors", () => {
	it("gives changed entries to the publisher and keeps the rest", () => {
		const before = parent({ "a.md": entry("a", 0), "b.md": entry("b", 1) });
		const { files, authors } = attribute(
			{ "a.md": entry("a", 0), "b.md": entry("b2"), "c.md": entry("c") },
			before,
			ALEX,
		);

		expect(authors).toEqual([SAM, GONE, ALEX]);
		expect(files["a.md"]).toEqual(before.files["a.md"]);
		expect(files["b.md"]?.by).toBe(2);
		expect(files["c.md"]?.by).toBe(2);
		expect(authorOf({ ...before, files, authors }, files["a.md"])).toEqual(SAM);
	});

	it("renames a returning publisher in place", () => {
		const before = parent({ "a.md": entry("a", 0) }, [
			{ key: "p1", name: "Old" },
			GONE,
		]);
		const { files, authors } = attribute({ "a.md": entry("a2") }, before, ALEX);

		expect(authors).toEqual([ALEX, GONE]);
		expect(files["a.md"]?.by).toBe(0);
	});

	it("leaves unknown authorship unknown", () => {
		const before = parent({ "a.md": entry("a") }, []);
		const { files } = attribute({ "a.md": entry("a") }, before, ALEX);

		expect(files["a.md"]?.by).toBeUndefined();
		expect(authorOf(before, files["a.md"])).toBeNull();
	});

	it("publishes as the device outside a share", () => {
		expect(
			publisher({ deviceId: "d1", deviceName: " Laptop " }, undefined),
		).toEqual({ key: "d1", name: "Laptop" });
		expect(publisher({ deviceId: "d1" }, ALEX)).toBe(ALEX);
	});
});
