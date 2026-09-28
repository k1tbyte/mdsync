import * as Y from "yjs";

import { toLf } from "@/utils/eol";

import { mergeThreeWay } from "./merge";
import type { LiveKind, LiveModel } from "./model";
import { patchYText } from "./patch";
import { BODY, rebuild } from "./rebuild";

/** A note: one Y.Text, merged line-wise and patched in as inserts and deletes. */
export class TextModel implements LiveModel {
	readonly text: Y.Text;
	/** Bindings add their own origins: the merge on open is never undone by a keystroke. */
	readonly undoManager: Y.UndoManager;

	constructor(private readonly doc: Y.Doc) {
		this.text = doc.getText(BODY);
		this.undoManager = new Y.UndoManager(this.text, {
			trackedOrigins: new Set(),
		});
	}

	merge(base: string, incoming: string): void {
		const room = this.text.toString();
		const next = toLf(incoming);
		if (next === room) return;
		patchYText(this.doc, this.text, mergeThreeWay(toLf(base), next, room));
	}

	agreed(): string {
		return this.text.toString();
	}

	rebuild(): Uint8Array {
		return rebuild(this.doc);
	}

	dispose(): void {
		this.undoManager.destroy();
	}
}

export const TEXT: LiveKind<TextModel> = {
	model: (doc) => new TextModel(doc),
	seed(disk) {
		const scratch = new Y.Doc();
		scratch.getText(BODY).insert(0, toLf(disk));
		const update = Y.encodeStateAsUpdate(scratch);
		scratch.destroy();
		return update;
	},
};
