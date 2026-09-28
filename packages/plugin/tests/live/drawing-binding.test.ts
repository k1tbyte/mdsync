import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { type SceneElement, wins } from "@/drawing";
import { bindDrawing } from "@/live/drawing/binding";
import type { ExcalidrawLib, ExcalidrawView } from "@/live/drawing/excalidraw";
import { DRAWING, type DrawingModel } from "@/live/drawing/model";
import type { LiveSession } from "@/live/session";

/** Excalidraw's reconcile, minus the element being edited. */
const LIB: ExcalidrawLib = {
	reconcileElements(local, remote) {
		const out = new Map(local.map((element) => [element.id, element]));
		for (const element of remote) {
			const mine = out.get(element.id);
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

function element(id: string, version = 1): SceneElement {
	return { id, version, versionNonce: version, index: `a${id}` };
}

/** An Excalidraw view whose scene changes as the plugin's does: `onChange` after every update. */
function fakeView(scene: SceneElement[]) {
	let elements = scene;
	const listeners = new Set<(elements: readonly SceneElement[]) => void>();
	const changed = () => {
		for (const listener of listeners) listener(elements);
	};
	const file = { path: "a.excalidraw.md" };
	const view = {
		file,
		excalidrawData: { file },
		excalidrawAPI: {
			getSceneElementsIncludingDeleted: () => elements,
			getAppState: () => ({}),
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
		contentEl: { addEventListener() {}, removeEventListener() {} },
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
		draw(next: SceneElement) {
			elements = [...elements.filter(({ id }) => id !== next.id), next];
			changed();
		},
		stamps: () => elements.map(({ id, version }) => `${id}@${version}`).sort(),
	};
}

function room(): LiveSession<DrawingModel> {
	const doc = new Y.Doc();
	Y.applyUpdate(doc, DRAWING.seed(JSON.stringify([element("1")])));
	return {
		doc,
		model: DRAWING.model(doc),
		awareness: new Awareness(doc),
		adopt() {},
	} as unknown as LiveSession<DrawingModel>;
}

function state(session: LiveSession<DrawingModel>): string[] {
	return [...session.model.elements.keys()].sort();
}

beforeEach(() => {
	(window as { ExcalidrawLib?: ExcalidrawLib }).ExcalidrawLib = LIB;
});

afterEach(() => {
	delete (window as { ExcalidrawLib?: ExcalidrawLib }).ExcalidrawLib;
});

describe("bindDrawing", () => {
	it("shows a stroke drawn in one view of the file in the other", () => {
		const session = room();
		const left = fakeView([element("1")]);
		const right = fakeView([element("1")]);
		bindDrawing(left.view, session);
		bindDrawing(right.view, session);

		left.draw(element("2"));

		expect(right.stamps()).toEqual(["1@1", "2@1"]);
	});

	it("lands an edit made over a newer version from elsewhere", () => {
		const session = room();
		const view = fakeView([element("1")]);
		bindDrawing(view.view, session);
		// Another device's edit, which this view has not taken yet.
		session.model.elements.set("1", element("1", 5));
		view.draw({ ...element("1", 2), versionNonce: 7 });

		const held = session.model.elements.get("1");
		expect(held?.version).toBe(6);
		expect(view.stamps()).toEqual(["1@6"]);
	});

	it("neither takes nor gives elements once its view shows another file", () => {
		const session = room();
		const view = fakeView([element("1")]);
		bindDrawing(view.view, session);

		view.switchTo("b.excalidraw.md", [element("b1")]);
		view.draw(element("b2"));
		session.model.put(element("3"));

		expect(state(session)).toEqual(["1", "3"]);
		expect(view.stamps()).toEqual(["b1@1", "b2@1"]);
	});

	it("binds nothing to a view still showing the file before", () => {
		const view = fakeView([element("1")]);
		view.view.excalidrawData = { file: null };
		expect(bindDrawing(view.view, room())).toBeNull();
	});

	it("stops following the room once detached", () => {
		const session = room();
		const view = fakeView([element("1")]);
		bindDrawing(view.view, session)?.detach();

		session.model.put(element("2"));

		expect(view.stamps()).toEqual(["1@1"]);
	});
});
