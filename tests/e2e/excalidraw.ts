/** The Excalidraw plugin's latest release, fetched once into `temp/` for the drawing e2e. */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const DIR = join(REPO, "temp", "e2e-plugins", "obsidian-excalidraw-plugin");
const RELEASE =
	"https://github.com/zsviczian/obsidian-excalidraw-plugin/releases/latest/download";
const FILES = ["main.js", "manifest.json", "styles.css"];

/** The plugin's folder, ready to copy into a vault. */
export async function excalidrawPlugin(): Promise<string> {
	mkdirSync(DIR, { recursive: true });
	for (const file of FILES) {
		const path = join(DIR, file);
		if (existsSync(path)) continue;
		const response = await fetch(`${RELEASE}/${file}`);
		if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
		writeFileSync(path, Buffer.from(await response.arrayBuffer()));
	}
	return DIR;
}
