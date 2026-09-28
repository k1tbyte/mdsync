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
 * How a file goes live, or null. The name does not say: an Excalidraw drawing
 * is a plain `.md` named by its front matter, and a text CRDT merging two edits
 * of its compressed scene yields a drawing that no longer opens.
 */
export function liveKindOf(app: App, file: TFile): LiveDocKind | null {
	if (file.extension !== "md") return null;
	const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
	const kind =
		frontmatter && "excalidraw-plugin" in frontmatter ? "drawing" : "text";
	return file.stat.size > MAX_LIVE_BYTES[kind] ? null : kind;
}
