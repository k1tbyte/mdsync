import type * as Y from "yjs";

/** What a live room holds, and how a version edited outside it folds in. */
export interface LiveModel {
	/** Folds `incoming` in, three-way against the version it grew from. */
	merge(base: string, incoming: string): void;
	/** The room's content as the merge base of the next open. */
	agreed(): string;
	/** Just the content, in a fresh document: what a rotation seeds. */
	rebuild(): Uint8Array;
	dispose(): void;
}

/** A view bound to its room. */
export interface BoundEditor {
	/** Tints what anyone but `me` typed; null takes the tint off. */
	showAuthors(me: string | null): void;
	detach(): void;
}

/** A kind of live document: text, or a drawing. */
export interface LiveKind<M extends LiveModel = LiveModel> {
	model(doc: Y.Doc): M;
	/** An empty room's first update: just the file's content. */
	seed(disk: string): Uint8Array;
}
