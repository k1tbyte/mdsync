import type { App, TFile } from "obsidian";

export type LiveDocKind = "text" | "drawing";

const LIVE_EXTENSION = "md";

/** Only notes go live (a drawing is one, see `docKindOf`): anything else would cost a key derivation per file. */
export function hasLiveExtension(path: string): boolean {
	return path.endsWith(`.${LIVE_EXTENSION}`);
}

/** The view type that edits each kind live. */
export const LIVE_VIEWS: Record<LiveDocKind, string> = {
	text: "markdown",
	drawing: "excalidraw",
};

/** Past this a live room costs more than the file is worth editing live. */
const MAX_LIVE_BYTES: Record<LiveDocKind, number> = {
	text: 256 * 1024,
	drawing: 1024 * 1024,
};

/**
 * What a file is to live editing, size aside. Front matter tells: a drawing is a
 * plain `.md`, and a text CRDT merging its compressed scene would corrupt it.
 * Null until Obsidian has indexed the file.
 */
export function docKindOf(app: App, file: TFile): LiveDocKind | null {
	if (file.extension !== LIVE_EXTENSION) return null;
	const cache = app.metadataCache.getFileCache(file);
	if (!cache) return null;
	return cache.frontmatter && "excalidraw-plugin" in cache.frontmatter
		? "drawing"
		: "text";
}

/** How a file goes live, or null: not a live kind, or too large. */
export function liveKindOf(app: App, file: TFile): LiveDocKind | null {
	const kind = docKindOf(app, file);
	return kind && file.stat.size > MAX_LIVE_BYTES[kind] ? null : kind;
}
