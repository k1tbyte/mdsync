import { type App, type CachedMetadata, TFile, TFolder } from "obsidian";
import { describe, expect, it } from "vitest";

import { isLinkable } from "@/ui/links/link-menu";

function appWith(cache: CachedMetadata | null): App {
	return { metadataCache: { getFileCache: () => cache } } as unknown as App;
}

function file(name: string): TFile {
	return Object.assign(new TFile(), {
		path: name,
		name,
		extension: name.split(".").pop(),
	});
}

describe("isLinkable", () => {
	it("offers notes and leaves out drawings, by name or by front matter", () => {
		const drawing = appWith({ frontmatter: { "excalidraw-plugin": "parsed" } });

		expect(isLinkable(appWith({}), file("trip.md"))).toBe(true);
		expect(isLinkable(appWith(null), file("trip.md"))).toBe(true);
		expect(isLinkable(drawing, file("sketch.md"))).toBe(false);
		expect(isLinkable(appWith(null), file("sketch.excalidraw.md"))).toBe(false);
		expect(isLinkable(appWith({}), file("photo.png"))).toBe(false);
		expect(isLinkable(appWith({}), new TFolder())).toBe(false);
	});
});
