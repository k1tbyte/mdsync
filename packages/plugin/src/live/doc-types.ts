import type { App, TFile } from "obsidian";

/** Past this a text CRDT costs more than the note is worth editing live. */
const MAX_LIVE_BYTES = 256 * 1024;

/**
 * Only plain markdown goes live. The name does not say what is inside: an
 * Excalidraw drawing can live in a plain `.md`, identified by its front matter,
 * and a text CRDT merging two edits of its compressed scene yields a drawing
 * that no longer opens. Anything with a shape of its own waits for an adapter.
 */
export function isLiveDocument(app: App, file: TFile): boolean {
	if (file.extension !== "md" || file.stat.size > MAX_LIVE_BYTES) return false;
	const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
	return !frontmatter || !("excalidraw-plugin" in frontmatter);
}
