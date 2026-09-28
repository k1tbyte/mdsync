/**
 * An Excalidraw drawing as the Obsidian plugin saves it: markdown whose front
 * matter names it, with the scene as JSON (plain or LZString) fenced under
 * "## Drawing". The scene also carries the view state of whichever device
 * saved it last.
 */

import { decompressFromBase64 } from "lz-string";

export interface SceneElement {
	id: string;
	version: number;
	versionNonce: number;
	isDeleted?: boolean;
	/** Fractional z-order. */
	index?: string;
	[key: string]: unknown;
}

export interface Scene {
	elements: SceneElement[];
	files?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface Drawing {
	scene: Scene;
	/** The fenced block, for putting another scene in its place. */
	start: number;
	end: number;
}

const BLOCK =
	/(## Drawing[ \t]*\r?\n)```(compressed-json|json)\r?\n([\s\S]*?)\r?\n```/;
const EMBEDDED = "## Embedded Files";

export function isDrawing(text: string): boolean {
	if (!text.startsWith("---")) return false;
	const end = text.indexOf("\n---", 3);
	return /^excalidraw-plugin:/m.test(end < 0 ? text : text.slice(0, end));
}

export function readDrawing(text: string): Drawing | null {
	if (!isDrawing(text)) return null;
	const match = BLOCK.exec(text);
	if (!match) return null;
	const [whole, heading = "", kind, body = ""] = match;
	const json =
		kind === "json" ? body : decompressFromBase64(body.replace(/\s+/g, ""));
	try {
		const scene: unknown = JSON.parse(json ?? "");
		if (!isScene(scene)) return null;
		const start = match.index + heading.length;
		return { scene, start, end: match.index + whole.length };
	} catch {
		return null;
	}
}

/** The same file around another scene, as plain JSON; the plugin compresses it again on save. */
export function withScene(text: string, at: Drawing, scene: Scene): string {
	const block = `\`\`\`json\n${JSON.stringify(scene)}\n\`\`\``;
	return text.slice(0, at.start) + block + text.slice(at.end);
}

/** The file's "fileId: link" lines, which is how the plugin finds each image. */
export function embeddedFiles(text: string): Map<string, string> {
	const out = new Map<string, string>();
	const from = text.indexOf(EMBEDDED);
	if (from < 0) return out;
	for (const line of text.slice(from + EMBEDDED.length + 1).split(/\r?\n/)) {
		if (line.startsWith("#") || line.startsWith("%%")) break;
		const at = line.indexOf(": ");
		if (at > 0) out.set(line.slice(0, at), line);
	}
	return out;
}

/** Adds the lines for images `text` does not know yet, before its scene. */
export function withEmbeddedFiles(
	text: string,
	lines: readonly string[],
): string {
	if (lines.length === 0) return text;
	const add = lines.join("\n\n");
	const section = text.indexOf(EMBEDDED);
	if (section >= 0) {
		const at = section + EMBEDDED.length;
		return `${text.slice(0, at)}\n${add}\n${text.slice(at)}`;
	}
	const drawing = text.search(/(%%\r?\n)?## Drawing/);
	const at = drawing < 0 ? text.length : drawing;
	return `${text.slice(0, at)}${EMBEDDED}\n${add}\n\n${text.slice(at)}`;
}

export function isElement(value: unknown): value is SceneElement {
	if (typeof value !== "object" || value === null) return false;
	const { id, version, versionNonce } = value as Partial<SceneElement>;
	return (
		typeof id === "string" &&
		typeof version === "number" &&
		typeof versionNonce === "number"
	);
}

function isScene(value: unknown): value is Scene {
	if (typeof value !== "object" || value === null) return false;
	const { elements } = value as { elements?: unknown };
	return Array.isArray(elements) && elements.every(isElement);
}
