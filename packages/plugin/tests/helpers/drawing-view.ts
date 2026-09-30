import { afterEach, beforeEach, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { type SceneElement, wins } from "@/drawing";
import type { ExcalidrawLib, ExcalidrawView } from "@/live/drawing/excalidraw";
import { DRAWING, type DrawingModel } from "@/live/drawing/model";
import type { LiveSession } from "@/live/session/session";

export const LIB: ExcalidrawLib = {
	reconcileElements(local, remote, appState) {
		const editing = (appState.editing as string[] | undefined) ?? [];
		const out = new Map(local.map((element) => [element.id, element]));
		for (const element of remote) {
			const mine = out.get(element.id);
			if (editing.includes(element.id)) continue;
			if (!mine || wins(element, mine)) out.set(element.id, element);
		}
		return [...out.values()];
	},
	viewportCoordsToSceneCoords: ({ clientX, clientY }) => ({
		x: clientX,
		y: clientY,
	}),
	bumpVersion(element, version = element.version) {
		element.version = version + 1;
		element.versionNonce = Math.floor(Math.random() * 2 ** 31);
	},
	CaptureUpdateAction: { NEVER: "NEVER" },
};

export const NO_STALE = () => {};
export const STROKE_FRAMES = 15;
export const STROKE_POINTS = 600;
export const DRAG_FRAMES = 10;
export const DRAGGED = ["d1", "d2", "d3"];

export function element(id: string, version = 1): SceneElement {
	return { id, version, versionNonce: version, index: `a${id}` };
}

export function stroke(frame: number): SceneElement {
	const length = (STROKE_POINTS * frame) / STROKE_FRAMES;
	const points = Array.from({ length }, (_, at) => [at * 1.37, at * 0.59, 0.5]);
	return { ...element("s", frame), points };
}

export const STROKE = Array.from({ length: STROKE_FRAMES }, (_, at) =>
	stroke(at + 1),
);

export function dragged(frame: number): SceneElement[] {
	return DRAGGED.map((id) => ({
		...element(id, frame + 1),
		x: frame * 10.5,
		y: frame * 3.25,
	}));
}

export function perFrameBytes(frames: SceneElement[]): number {
	const doc = new Y.Doc();
	const model = DRAWING.model(doc);
	const updates: Uint8Array[] = [];
	doc.on("update", (update: Uint8Array) => updates.push(update));
	for (const frame of frames) model.put(frame);
	return Y.mergeUpdates(updates).length;
}

/** An Excalidraw view whose scene changes as the plugin's does: `onChange` after every update. */
export function fakeView(scene: SceneElement[], appState = {}) {
	let elements = scene;
	const listeners = new Set<(elements: readonly SceneElement[]) => void>();
	const changed = () => {
		for (const listener of listeners) listener(elements);
	};
	const file = { path: "a.excalidraw.md" };
	const handlers = new Map<string, (event: unknown) => void>();
	const view = {
		file,
		excalidrawData: { file },
		excalidrawAPI: {
			getSceneElementsIncludingDeleted: () => elements,
			getAppState: () => appState,
			updateScene(next: { elements?: readonly SceneElement[] }) {
				if (!next.elements) return;
				elements = [...next.elements];
				changed();
			},
			onChange(listener: (elements: readonly SceneElement[]) => void) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
		contentEl: {
			addEventListener: (type: string, handler: (event: unknown) => void) =>
				handlers.set(type, handler),
			removeEventListener: (type: string) => handlers.delete(type),
		},
	} as unknown as ExcalidrawView;
	return {
		view,
		/** Obsidian names the next file first; the plugin loads its scene after. */
		switchTo(path: string, scene: SceneElement[]) {
			const next = { path } as unknown as ExcalidrawView["file"];
			view.file = next;
			elements = scene;
			changed();
			view.excalidrawData = { file: next };
		},
		draw(...next: SceneElement[]) {
			const ids = new Set(next.map(({ id }) => id));
			elements = [...elements.filter(({ id }) => !ids.has(id)), ...next];
			changed();
		},
		move(clientX: number, clientY: number) {
			handlers.get("pointermove")?.({ clientX, clientY });
		},
		leave() {
			handlers.get("pointerleave")?.({});
		},
		listening: () => handlers.size,
		stamps: () => elements.map(({ id, version }) => `${id}@${version}`).sort(),
	};
}

export function room(elements = [element("1")]): LiveSession<DrawingModel> {
	const doc = new Y.Doc();
	Y.applyUpdate(doc, DRAWING.seed(JSON.stringify(elements)));
	const staged = new Set<() => void>();
	return {
		doc,
		model: DRAWING.model(doc),
		awareness: new Awareness(doc),
		adopt() {},
		stage: (drain: () => void) => staged.add(drain),
		drainStaged() {
			const drains = [...staged];
			staged.clear();
			for (const drain of drains) drain();
		},
	} as unknown as LiveSession<DrawingModel>;
}

export function updatesOf(session: LiveSession<DrawingModel>): Uint8Array[] {
	const updates: Uint8Array[] = [];
	session.doc.on("update", (update: Uint8Array) => updates.push(update));
	return updates;
}

export function held(session: LiveSession<DrawingModel>, id: string) {
	return session.model.elements.get(id);
}

export function pointsHeld(session: LiveSession<DrawingModel>, id: string) {
	return (held(session, id)?.points as unknown[] | undefined)?.length;
}

export function state(session: LiveSession<DrawingModel>): string[] {
	return [...session.model.elements.keys()].sort();
}

export function useExcalidrawLib(): void {
	beforeEach(() => {
		(window as { ExcalidrawLib?: ExcalidrawLib }).ExcalidrawLib = LIB;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		delete (window as { ExcalidrawLib?: ExcalidrawLib }).ExcalidrawLib;
	});
}
