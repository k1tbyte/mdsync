import type * as Y from "yjs";

export interface LiveModel {
	/** Folds `incoming` in, three-way against the version it grew from. */
	merge(base: string, incoming: string): void;
	/** The room's content as the merge base of the next open. */
	agreed(): string;
	/** Just the content, in a fresh document: what a rotation seeds. */
	rebuild(): Uint8Array;
	dispose(): void;
}

export interface BoundEditor {
	/** Tints what anyone but `me` typed; null takes the tint off. */
	showAuthors(me: string | null): void;
	/** The view let go of what this binding holds: it binds again. */
	stale?(): boolean;
	detach(): void;
}

export interface LiveKind<M extends LiveModel = LiveModel> {
	model(doc: Y.Doc): M;
	/** An empty room's first update: just the file's content. */
	seed(disk: string): Uint8Array;
	/** Whether a file with `disk` holds what a room `agreed`. */
	holds(agreed: string, disk: string): boolean;
}
