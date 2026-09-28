import { sha256Hex } from "@/crypto";

import { isDrawing, readDrawing, type SceneElement } from "./format";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
/** Front matter sits at the top; a drawing names itself well before this. */
const HEAD_BYTES = 1024;

/**
 * What a drawing is, whatever view state it was saved with: its text outside
 * the scene, and which elements show at which version. Undefined for anything
 * that is not a drawing.
 */
export async function sceneOf(text: string): Promise<string | undefined> {
	const drawing = readDrawing(text);
	if (!drawing) return undefined;
	const shown = drawing.scene.elements
		.filter((element) => !element.isDeleted)
		.map(stamp)
		.sort();
	const outside = text.slice(0, drawing.start) + text.slice(drawing.end);
	return sha256Hex(encoder.encode(JSON.stringify([outside, shown])));
}

/** The same for a file's bytes, decoding only what looks like a drawing. */
export async function sceneOfBytes(
	path: string,
	bytes: Uint8Array,
): Promise<string | undefined> {
	if (!path.endsWith(".md")) return undefined;
	if (!isDrawing(decoder.decode(bytes.subarray(0, HEAD_BYTES)))) {
		return undefined;
	}
	return sceneOf(decoder.decode(bytes));
}

/** An element at one version: any edit gives it a new nonce. */
export function stamp({ id, version, versionNonce }: SceneElement): string {
	return `${id}:${version}:${versionNonce}`;
}
