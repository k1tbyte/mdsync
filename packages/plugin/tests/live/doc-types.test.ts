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
});
