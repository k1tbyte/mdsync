import * as Y from "yjs";

import {
	isElement,
	mergeElements,
	readDrawing,
	type SceneElement,
	wins,
} from "@/drawing";

import type { LiveKind, LiveModel } from "../model";

const ELEMENTS = "elements";

/** A drawing: each element whole under its id; Excalidraw's version rule settles two writes of one. */
export class DrawingModel implements LiveModel {
	readonly elements: Y.Map<SceneElement>;

	constructor(private readonly doc: Y.Doc) {
		this.elements = doc.getMap(ELEMENTS);
	}

	merge(base: string, incoming: string): void {
		const next = elementsIn(incoming);
		if (!next) return;
		const room = [...this.elements.values()];
		const merged = mergeElements(elementsIn(base) ?? [], next, room);
		const kept = new Set(merged.map(({ id }) => id));
		this.doc.transact(() => {
			for (const element of merged) this.put(element);
			// Dropped outside and unchanged here: everyone's view has to drop it too.
			for (const element of room) {
				if (!kept.has(element.id) && !element.isDeleted) {
					this.put(tombstone(element));
				}
			}
		});
	}

	/** Takes a copy of `element` where it beats the room's: a view mutates the ones it hands in. */
	put(element: SceneElement): void {
		const held = this.elements.get(element.id);
		if (!held || wins(element, held)) {
			this.elements.set(element.id, { ...element });
		}
	}

	/** Which elements at which version: all the next merge needs of its base. */
	agreed(): string {
		return JSON.stringify(
			[...this.elements.values()].map(
				({ id, version, versionNonce, isDeleted }) => ({
					id,
					version,
					versionNonce,
					isDeleted,
				}),
			),
		);
	}

	rebuild(): Uint8Array {
		return withElements(this.elements.values());
	}

	dispose(): void {}
}

export const DRAWING: LiveKind<DrawingModel> = {
	model: (doc) => new DrawingModel(doc),
	seed: (disk) => withElements(elementsIn(disk) ?? []),
};

/** A drawing file, a scene, or the stamps a room agreed on; null when none. */
export function elementsIn(text: string): SceneElement[] | null {
	const drawing = readDrawing(text);
	if (drawing) return drawing.scene.elements;
	try {
		const parsed: unknown = JSON.parse(text);
		const list = Array.isArray(parsed)
			? parsed
			: (parsed as { elements?: unknown } | null)?.elements;
		return Array.isArray(list) ? list.filter(isElement) : null;
	} catch {
		return null;
	}
}

function tombstone(element: SceneElement): SceneElement {
	return {
		...element,
		isDeleted: true,
		version: element.version + 1,
		versionNonce: Math.floor(Math.random() * 2 ** 31),
		updated: Date.now(),
	};
}

function withElements(elements: Iterable<SceneElement>): Uint8Array {
	const doc = new Y.Doc();
	const map = doc.getMap<SceneElement>(ELEMENTS);
	for (const element of elements) map.set(element.id, element);
	const update = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	return update;
}
