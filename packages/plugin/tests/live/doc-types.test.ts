import { type App, type CachedMetadata, TFile } from "obsidian";
import { describe, expect, it } from "vitest";

import { docKindOf, liveKindOf } from "@/live/doc-types";

function appWith(cache: CachedMetadata | null): App {
	return { metadataCache: { getFileCache: () => cache } } as unknown as App;
}

function file(path: string, size = 10): TFile {
	return Object.assign(new TFile(), {
		path,
		extension: path.split(".").pop(),
		stat: { size },
	});
}

describe("live document kinds", () => {
	it("reads the kind from front matter, and none before Obsidian indexed the file", () => {
		const drawing = { frontmatter: { "excalidraw-plugin": "parsed" } };

		expect(docKindOf(appWith({}), file("a.md"))).toBe("text");
		expect(docKindOf(appWith(drawing), file("a.md"))).toBe("drawing");
		expect(docKindOf(appWith(null), file("a.md"))).toBeNull();
		expect(docKindOf(appWith({}), file("a.png"))).toBeNull();
	});

	it("keeps files past their kind's size out of live editing", () => {
		expect(liveKindOf(appWith({}), file("a.md", 300 * 1024))).toBeNull();
		expect(liveKindOf(appWith({}), file("a.md", 200 * 1024))).toBe("text");
	});

	it("cuts a note off at 256 KiB and a drawing at 1 MiB, each size itself still live", () => {
		const drawing = { frontmatter: { "excalidraw-plugin": "parsed" } };

		expect(liveKindOf(appWith({}), file("a.md", 256 * 1024))).toBe("text");
		expect(liveKindOf(appWith({}), file("a.md", 256 * 1024 + 1))).toBeNull();
		expect(liveKindOf(appWith(drawing), file("a.md", 300 * 1024))).toBe(
			"drawing",
		);
		expect(liveKindOf(appWith(drawing), file("a.md", 1024 * 1024))).toBe(
			"drawing",
		);
		expect(
			liveKindOf(appWith(drawing), file("a.md", 1024 * 1024 + 1)),
		).toBeNull();
	});

	it("is none for a file Obsidian has not indexed yet, and answers once it has", () => {
		let cache: CachedMetadata | null = null;
		const app = {
			metadataCache: { getFileCache: () => cache },
		} as unknown as App;
		const note = file("a.md");

		expect(liveKindOf(app, note)).toBeNull();
		cache = {
			frontmatter: { "excalidraw-plugin": "parsed" },
		} as CachedMetadata;
		expect(liveKindOf(app, note)).toBe("drawing");
	});

	it("keeps anything but a markdown file out, however small", () => {
		expect(liveKindOf(appWith({}), file("board.canvas"))).toBeNull();
		expect(liveKindOf(appWith({}), file("photo.png", 1))).toBeNull();
	});
});
