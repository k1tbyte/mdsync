// @vitest-environment jsdom
import type { App, TFile } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { IMAGE_MAX_BYTES, inlineImage } from "@/links/images";

const sourcePath = "notes/Trip.md";

function imageApp(extension = "png", bytes = new ArrayBuffer(0)) {
	const file = { path: `images/photo.${extension}`, extension } as TFile;
	const getFirstLinkpathDest = vi.fn((): TFile | null => file);
	const readBinary = vi.fn(async () => bytes);
	const app = {
		metadataCache: { getFirstLinkpathDest },
		vault: { readBinary },
	} as unknown as App;
	return { app, file, getFirstLinkpathDest, readBinary };
}

describe("inlineImage", () => {
	it("inlines a small PNG as a data URI", async () => {
		const png = new Uint8Array([
			137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
		]);
		const { app, file, getFirstLinkpathDest, readBinary } = imageApp(
			"png",
			png.buffer,
		);

		expect(await inlineImage(app, sourcePath, "images/photo.png")).toBe(
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
		);
		expect(getFirstLinkpathDest).toHaveBeenCalledWith(
			"images/photo.png",
			sourcePath,
		);
		expect(readBinary).toHaveBeenCalledWith(file);
	});

	it("decodes spaces in vault image links", async () => {
		const { app, getFirstLinkpathDest } = imageApp();

		await inlineImage(app, sourcePath, "images/my%20photo.png");

		expect(getFirstLinkpathDest).toHaveBeenCalledWith(
			"images/my photo.png",
			sourcePath,
		);
	});

	it("returns null for a missing vault image", async () => {
		const { app, getFirstLinkpathDest, readBinary } = imageApp();
		getFirstLinkpathDest.mockReturnValueOnce(null);

		expect(await inlineImage(app, sourcePath, "missing.png")).toBeNull();
		expect(readBinary).not.toHaveBeenCalled();
	});

	it("returns null for a non-image extension", async () => {
		const { app, readBinary } = imageApp("md");

		expect(await inlineImage(app, sourcePath, "note.md")).toBeNull();
		expect(readBinary).not.toHaveBeenCalled();
	});

	it("returns null for an image over the cap without re-encoding GIFs", async () => {
		const { app } = imageApp("gif", new ArrayBuffer(IMAGE_MAX_BYTES + 1));

		expect(await inlineImage(app, sourcePath, "images/photo.gif")).toBeNull();
	});
});
