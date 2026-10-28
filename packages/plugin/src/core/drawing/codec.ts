/**
 * Excalidraw's `compressed-json` scene is one LZString stream: any edit rewrites all of it, so neither gzip nor
 * chunking can share bytes between versions. The stored form carries the scene as plain JSON instead; the wrap
 * the plugin applied to the base64 is kept so the original bytes come back.
 */

import { compressToBase64, decompressFromBase64 } from "lz-string";

import { HEAD_BYTES, isDrawing, SCENE_BLOCK } from "./format";

export interface DrawingCodec {
	name: "excalidraw-lz";
	/** Base64 characters per line. */
	width: number;
	/** What follows each full line. */
	gap: string;
}

const NAME = "excalidraw-lz";
const MAX_GAP = 16;
/** A bigger scene is stored as it is: rebuilding it on every read would hold the main thread for seconds. */
const MAX_SCENE_CHARS = 2 * 1024 * 1024;

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const encoder = new TextEncoder();

export function isDrawingCodec(value: unknown): value is DrawingCodec {
	if (typeof value !== "object" || value === null) return false;
	const { name, width, gap } = value as Partial<DrawingCodec>;
	return (
		Object.keys(value).length === 3 &&
		name === NAME &&
		typeof width === "number" &&
		Number.isInteger(width) &&
		width > 0 &&
		typeof gap === "string" &&
		gap.length <= MAX_GAP &&
		/^\s*$/.test(gap)
	);
}

/**
 * Null for anything but a drawing whose scene is `compressed-json` and whose decoded form rebuilds the very
 * same bytes: a file this cannot reproduce is stored as it is.
 */
export function encodeDrawing(
	bytes: Uint8Array,
): { stored: Uint8Array; codec: DrawingCodec } | null {
	try {
		if (!isDrawing(decoder.decode(bytes.subarray(0, HEAD_BYTES)))) return null;
		const text = decoder.decode(bytes);
		const match = SCENE_BLOCK.exec(text);
		if (match?.[2] !== "compressed-json") return null;
		const [whole = "", heading = "", , lineBreak = "", body = "", close = ""] =
			match;
		const json = decompressFromBase64(body.replace(/\s+/g, ""));
		if (!json || json.length > MAX_SCENE_CHARS) return null;
		const codec: DrawingCodec = { name: NAME, ...wrapOf(body) };
		if (!isDrawingCodec(codec)) return null;
		const stored = encoder.encode(
			`${text.slice(0, match.index)}${heading}\`\`\`json${lineBreak}${json}${close}\`\`\`${text.slice(match.index + whole.length)}`,
		);
		return same(decodeDrawing(stored, codec), bytes) ? { stored, codec } : null;
	} catch {
		return null;
	}
}

/** Throws when `stored` holds no scene block; the caller's hash check is the guard on what it returns. */
export function decodeDrawing(
	stored: Uint8Array,
	codec: DrawingCodec,
): Uint8Array {
	if (!isDrawingCodec(codec)) throw new Error("Unknown drawing codec");
	const text = decoder.decode(stored);
	const match = SCENE_BLOCK.exec(text);
	if (match?.[2] !== "json") throw new Error("Stored drawing has no scene");
	const [whole = "", heading = "", , lineBreak = "", json = "", close = ""] =
		match;
	const packed = wrap(compressToBase64(json), codec);
	return encoder.encode(
		`${text.slice(0, match.index)}${heading}\`\`\`compressed-json${lineBreak}${packed}${close}\`\`\`${text.slice(match.index + whole.length)}`,
	);
}

/**
 * The first line's length and the whitespace after it, as the writer chose them (the Excalidraw plugin: 256
 * and a blank line). One line with no break is its own width and no gap.
 */
function wrapOf(body: string): { width: number; gap: string } {
	const width = body.search(/\s/);
	if (width < 0) return { width: body.length, gap: "" };
	const run = /\s+/y;
	run.lastIndex = width;
	return { width, gap: run.exec(body)?.[0] ?? "" };
}

/** `base64.replace(/(.{width})/g, "$1" + gap)`, without building a pattern from the width. */
function wrap(base64: string, { width, gap }: DrawingCodec): string {
	const lines: string[] = [];
	for (let at = 0; at < base64.length; at += width) {
		const line = base64.slice(at, at + width);
		lines.push(line.length === width ? line + gap : line);
	}
	return lines.join("");
}

function same(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}
