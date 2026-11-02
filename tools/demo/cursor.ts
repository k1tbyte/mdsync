/** A drawn cursor for synthetic input, which moves no real pointer: the .cur files in artifacts/cursors when all are there, else a plain arrow. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "playwright-core";

type Kind = "default" | "pointer" | "text";

interface CursorImage {
	width: number;
	height: number;
	hotX: number;
	hotY: number;
	rgba: number[];
}

/** Not in git: the files are someone else's artwork, so a clone falls back to the arrow. */
const CURSOR_DIR = "artifacts/cursors";

const CURSOR_FILES: Record<Kind, string> = {
	default: "pointer.cur",
	pointer: "link.cur",
	text: "beam.cur",
};

export async function installCursor(page: Page): Promise<void> {
	await page.evaluate((scheme) => {
		const ARROW = `data:image/svg+xml,${encodeURIComponent(
			'<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"><path d="M4 2l15 11.5-6.4.9 3.7 7.3-2.9 1.4-3.6-7.3L4 20z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>',
		)}`;
		const toUrl = (image: CursorImage | undefined) => {
			if (!image) return { url: ARROW, hotX: 3, hotY: 2 };
			const canvas = document.createElement("canvas");
			canvas.width = image.width;
			canvas.height = image.height;
			const pixels = new ImageData(
				Uint8ClampedArray.from(image.rgba),
				image.width,
				image.height,
			);
			canvas.getContext("2d")?.putImageData(pixels, 0, 0);
			return { url: canvas.toDataURL(), hotX: image.hotX, hotY: image.hotY };
		};
		const images = {
			default: toUrl(scheme?.default),
			pointer: toUrl(scheme?.pointer),
			text: toUrl(scheme?.text),
		};

		document.getElementById("demo-cursor")?.remove();
		const cursor = document.createElement("img");
		cursor.id = "demo-cursor";
		const style = document.createElement("style");
		style.textContent = `
			#demo-cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none;
				transform: translate(-100px, -100px); }
			.demo-ripple { position: fixed; z-index: 2147483646; pointer-events: none; width: 28px; height: 28px;
				margin: -14px 0 0 -14px; border-radius: 50%; background: rgb(255 255 255 / 0.35);
				animation: demo-ripple 420ms ease-out forwards; }
			@keyframes demo-ripple { from { transform: scale(0.3); opacity: 1; } to { transform: scale(1.6); opacity: 0; } }
			/* Hover tooltips pop up wherever the pointer pauses: noise in a take. */
			.tooltip { display: none !important; }
		`;
		document.head.append(style);
		document.body.append(cursor);
		let shown = "";
		document.addEventListener(
			"mousemove",
			(event) => {
				const under = document.elementFromPoint(event.clientX, event.clientY);
				const css = under ? getComputedStyle(under).cursor : "default";
				const image =
					css === "pointer" || css === "text" ? images[css] : images.default;
				if (shown !== image.url) cursor.src = shown = image.url;
				cursor.style.transform = `translate(${event.clientX - image.hotX}px, ${event.clientY - image.hotY}px)`;
			},
			true,
		);
		document.addEventListener(
			"mousedown",
			(event) => {
				const ripple = document.createElement("div");
				ripple.className = "demo-ripple";
				ripple.style.left = `${event.clientX}px`;
				ripple.style.top = `${event.clientY}px`;
				document.body.append(ripple);
				setTimeout(() => ripple.remove(), 450);
			},
			true,
		);
	}, loadScheme());
}

function loadScheme(): Record<Kind, CursorImage> | null {
	const scheme: Partial<Record<Kind, CursorImage>> = {};
	for (const [kind, file] of Object.entries(CURSOR_FILES) as [Kind, string][]) {
		const path = join(CURSOR_DIR, file);
		const image = existsSync(path) && parseCur(path);
		if (!image) return null;
		scheme[kind] = image;
	}
	return scheme as Record<Kind, CursorImage>;
}

/** A .cur's first image, when it is a 32-bit bitmap (PNG-packed ones are not read). */
function parseCur(path: string): CursorImage | null {
	const file = readFileSync(path);
	const offset = file.readUInt32LE(18);
	if (file.readUInt16LE(offset + 14) !== 32) return null;
	const width = file.readInt32LE(offset + 4);
	const height = file.readInt32LE(offset + 8) / 2;
	const pixels = offset + file.readUInt32LE(offset);
	const rgba: number[] = [];
	// Bitmap rows run bottom-up, each pixel BGRA.
	for (let y = height - 1; y >= 0; y--) {
		for (let x = 0; x < width; x++) {
			const at = pixels + (y * width + x) * 4;
			rgba.push(
				file[at + 2] ?? 0,
				file[at + 1] ?? 0,
				file[at] ?? 0,
				file[at + 3] ?? 0,
			);
		}
	}
	return {
		width,
		height,
		hotX: file.readUInt16LE(10),
		hotY: file.readUInt16LE(12),
		rgba,
	};
}
