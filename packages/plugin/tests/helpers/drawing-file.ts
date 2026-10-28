import { compressToBase64 } from "lz-string";
import { seeded } from "./seeded";

const encoder = new TextEncoder();

/** A scene shaped like Excalidraw's own: the fields every element carries, a few text elements. */
export function sceneJson(elements = 40, note = ""): string {
	const random = seeded(7);
	const shapes = Array.from({ length: elements }, (_, at) => ({
		id: `el${at.toString(36)}${Math.floor(random() * 1e9).toString(36)}`,
		type: at % 5 === 0 ? "text" : "rectangle",
		x: Math.round(random() * 2000) / 3,
		y: Math.round(random() * 2000) / 3,
		width: 120 + at,
		height: 60,
		angle: 0,
		strokeColor: "#1e1e1e",
		backgroundColor: "transparent",
		fillStyle: "solid",
		strokeWidth: 2,
		roughness: 1,
		opacity: 100,
		groupIds: [],
		index: `a${at}`,
		seed: Math.floor(random() * 2 ** 31),
		version: 1 + at,
		versionNonce: Math.floor(random() * 2 ** 31),
		isDeleted: false,
		boundElements: null,
		updated: 1_750_000_000_000 + at,
		link: null,
		locked: false,
		...(at % 5 === 0 ? { text: `label ${at}`, fontSize: 20 } : {}),
	}));
	return JSON.stringify({
		type: "excalidraw",
		version: 2,
		elements: shapes,
		appState: { gridSize: null, viewBackgroundColor: "#ffffff", note },
		files: {},
	});
}

/** What obsidian-excalidraw-plugin writes: 256 base64 characters a line, a blank line between lines. */
export function wrapLikeExcalidraw(base64: string): string {
	return base64.replace(/(.{256})/g, "$1\n\n");
}

/** A drawing file around `block`, the way the plugin lays it out. */
export function drawingAround(block: string): string {
	return `---

excalidraw-plugin: parsed
tags: [excalidraw]

---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==


# Excalidraw Data

## Text Elements
label 0 ^abc123

%%
## Drawing
${block}
%%
`;
}

export function compressedDrawing(json = sceneJson()): string {
	return drawingAround(
		`\`\`\`compressed-json\n${wrapLikeExcalidraw(compressToBase64(json))}\n\`\`\``,
	);
}

export function plainDrawing(json = sceneJson()): string {
	return drawingAround(`\`\`\`json\n${json}\n\`\`\``);
}

/** A scene whose LZString base64 is an exact multiple of 256 characters, so the last line is a full one. */
export function exactMultipleScene(): string {
	const random = seeded(11);
	let note = "";
	for (let size = 0; size < 4000; size++) {
		note += String.fromCharCode(33 + Math.floor(random() * 90));
		const json = sceneJson(10, note);
		if (compressToBase64(json).length % 256 === 0) return json;
	}
	throw new Error("no scene with a 256-multiple base64 length");
}

export function bytesOf(text: string): Uint8Array {
	return encoder.encode(text);
}
