// @vitest-environment jsdom
import type { App, TFile } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function redraw(size: number) {
	const bitmap = { width: 3200, height: 1600, close: vi.fn() };
	const createBitmap = vi.fn(async () => bitmap);
	const drawImage = vi.fn();
	const convertToBlob = vi.fn(
		async () => new Blob([new ArrayBuffer(size)], { type: "image/webp" }),
	);
	const canvas = vi.fn(function (
		this: OffscreenCanvas,
		width: number,
		height: number,
	) {
		Object.assign(this, {
			width,
			height,
			getContext: () => ({ drawImage }),
			convertToBlob,
		});
	});
	vi.stubGlobal("createImageBitmap", createBitmap);
	vi.stubGlobal("OffscreenCanvas", canvas);
	return { createBitmap, canvas, drawImage, convertToBlob, bitmap };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

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

	it.each(["jpg", "jpeg"])(
		"redraws even a small %s and keeps a larger redraw",
		async (extension) => {
			const { app } = imageApp(extension, new ArrayBuffer(1));
			const { createBitmap, canvas, drawImage, convertToBlob, bitmap } =
				redraw(2);

			expect(await inlineImage(app, sourcePath, "photo.jpg")).toBe(
				"data:image/webp;base64,AAA=",
			);
			expect(createBitmap).toHaveBeenCalledOnce();
			expect(canvas).toHaveBeenCalledWith(1600, 800);
			expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 1600, 800);
			expect(bitmap.close).toHaveBeenCalledOnce();
			expect(convertToBlob).toHaveBeenCalledWith({
				type: "image/webp",
				quality: 0.82,
			});
		},
	);

	it.each(["jpg", "png"])(
		"handles a failed %s redraw without leaking JPEG metadata",
		async (extension) => {
			const { app } = imageApp(
				extension,
				new ArrayBuffer(extension === "jpg" ? 1 : 301 * 1024),
			);
			const { createBitmap } = redraw(1);
			createBitmap.mockRejectedValueOnce(new Error("Cannot decode"));

			const uri = await inlineImage(app, sourcePath, "photo");
			if (extension === "jpg") expect(uri).toBeNull();
			else expect(uri).toMatch(/^data:image\/png;base64,/);
		},
	);

	it.each(["png", "webp", "bmp", "avif"])(
		"only redraws %s above 300 KiB and keeps a smaller result",
		async (extension) => {
			const { app } = imageApp(extension, new ArrayBuffer(300 * 1024));
			const { createBitmap } = redraw(1);
			await inlineImage(app, sourcePath, "photo");
			expect(createBitmap).not.toHaveBeenCalled();

			const large = imageApp(extension, new ArrayBuffer(300 * 1024 + 1));
			expect(await inlineImage(large.app, sourcePath, "photo")).toBe(
				"data:image/webp;base64,AA==",
			);
			expect(createBitmap).toHaveBeenCalledOnce();
		},
	);

	it.each([301 * 1024, 302 * 1024])(
		"keeps the original PNG when its redraw is not smaller (%i bytes)",
		async (size) => {
			const { app } = imageApp("png", new ArrayBuffer(301 * 1024));
			const { createBitmap } = redraw(size);
			expect(await inlineImage(app, sourcePath, "photo")).toMatch(
				/^data:image\/png;base64,/,
			);
			expect(createBitmap).toHaveBeenCalledOnce();
		},
	);

	it.each(["gif", "svg"])("never redraws %s", async (extension) => {
		const { app } = imageApp(extension, new ArrayBuffer(301 * 1024));
		const { createBitmap } = redraw(1);
		expect(await inlineImage(app, sourcePath, "photo")).toMatch(
			/^data:image\//,
		);
		expect(createBitmap).not.toHaveBeenCalled();
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
