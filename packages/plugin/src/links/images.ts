import type { App } from "obsidian";

const MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	bmp: "image/bmp",
	avif: "image/avif",
};
/** An image under this goes as it is; a bigger photo is re-encoded smaller. */
const KEEP_BYTES = 300 * 1024;
const MAX_EDGE = 1600;
/** A note's images share the link's size limit with its text. */
export const IMAGE_MAX_BYTES = 1.5 * 1024 * 1024;
const REENCODE_QUALITY = 0.82;

/** The vault image a note links to as a `data:` URI; null when it is missing, not an image, or too big. */
export async function inlineImage(
	app: App,
	sourcePath: string,
	link: string,
): Promise<string | null> {
	const target = app.metadataCache.getFirstLinkpathDest(
		decodeLink(link),
		sourcePath,
	);
	const mime = target && MIME[target.extension.toLowerCase()];
	if (!target || !mime) return null;
	const bytes = await app.vault.readBinary(target);
	let blob = new Blob([bytes], { type: mime });
	// An animation or vector would lose what makes it itself.
	const flat = mime !== "image/gif" && mime !== "image/svg+xml";
	if (flat && bytes.byteLength > KEEP_BYTES) {
		const smaller = await reencode(blob);
		if (smaller && smaller.size < blob.size) blob = smaller;
	}
	return blob.size <= IMAGE_MAX_BYTES ? readAsDataUrl(blob) : null;
}

/** Obsidian writes links with spaces as `%20` in some embeds. */
function decodeLink(link: string): string {
	try {
		return decodeURIComponent(link);
	} catch {
		return link;
	}
}

async function reencode(blob: Blob): Promise<Blob | null> {
	try {
		const bitmap = await createImageBitmap(blob);
		const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
		const canvas = new OffscreenCanvas(
			Math.max(1, Math.round(bitmap.width * scale)),
			Math.max(1, Math.round(bitmap.height * scale)),
		);
		canvas
			.getContext("2d")
			?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		bitmap.close();
		return await canvas.convertToBlob({
			type: "image/webp",
			quality: REENCODE_QUALITY,
		});
	} catch {
		return null;
	}
}

function readAsDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(blob);
	});
}
