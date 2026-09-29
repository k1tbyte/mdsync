import type { App, TFile } from "obsidian";

export type LiveDocKind = "text" | "drawing";

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
 * What a file is to live editing, size aside. The name does not say: an
 * Excalidraw drawing is a plain `.md` named by its front matter, and a text
 * CRDT merging two edits of its compressed scene yields a drawing that no
 * longer opens.
 */
export function docKindOf(app: App, file: TFile): LiveDocKind | null {
	if (file.extension !== "md") return null;
	const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
	return frontmatter && "excalidraw-plugin" in frontmatter ? "drawing" : "text";
}

/** How a file goes live, or null: not a live kind, or too large. */
export function liveKindOf(app: App, file: TFile): LiveDocKind | null {
	const kind = docKindOf(app, file);
	return kind && file.stat.size > MAX_LIVE_BYTES[kind] ? null : kind;
}
