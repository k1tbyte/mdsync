import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import type { SceneElement } from "@/drawing";
import { DRAWING, elementsIn } from "@/live/drawing/model";

function element(id: string, version = 1, isDeleted?: boolean): SceneElement {
	return { id, version, versionNonce: version, index: `a${id}`, isDeleted };
}

function drawing(elements: SceneElement[]): string {
	const json = JSON.stringify({ type: "excalidraw", elements });
	return `---\n\nexcalidraw-plugin: parsed\n\n---\n# Excalidraw Data\n%%\n## Drawing\n\`\`\`json\n${json}\n\`\`\`\n%%\n`;
}

function scene(elements: SceneElement[]): string {
	return JSON.stringify({ elements });
}

/** A room seeded from `disk`, as the first device opens it. */
function room(disk: string) {
	const doc = new Y.Doc();
	Y.applyUpdate(doc, DRAWING.seed(disk));
	return { doc, model: DRAWING.model(doc) };
}

function state(model: ReturnType<typeof room>["model"]): string[] {
	return [...model.elements.values()]
		.map(({ id, version, isDeleted }) =>
			isDeleted ? `${id}@${version}-` : `${id}@${version}`,
		)
		.sort();
}

describe("DrawingModel", () => {
	it("seeds a room with the file's elements", () => {
		const { model } = room(drawing([element("1"), element("2")]));
		expect(state(model)).toEqual(["1@1", "2@1"]);
	});

	it("takes elements added outside and keeps its own newer ones", () => {
		const base = [element("1"), element("2")];
		const { model } = room(scene(base));
		model.put(element("2", 3));
		model.merge(scene(base), drawing([...base, element("3")]));
		expect(state(model)).toEqual(["1@1", "2@3", "3@1"]);
	});

	it("deletes for everyone what the file dropped unchanged", () => {
		const base = [element("1"), element("2")];
		const { model } = room(scene(base));
		model.merge(scene(base), drawing([element("1")]));
		expect(state(model)).toEqual(["1@1", "2@2-"]);
	});

	it("keeps what the file dropped once the room changed it", () => {
		const base = [element("1"), element("2")];
		const { model } = room(scene(base));
		model.put(element("2", 4));
		model.merge(scene(base), drawing([element("1")]));
		expect(state(model)).toEqual(["1@1", "2@4"]);
	});

	it("merges against its own agreed stamps without touching the room", () => {
		const { doc, model } = room(scene([element("1"), element("2", 2, true)]));
		const agreed = model.agreed();
		let updates = 0;
		doc.on("update", () => updates++);
		// The saved file leaves deleted elements out.
		model.merge(agreed, drawing([element("1")]));
		expect(updates).toBe(0);
	});

	it("holds its own copy of what a view hands it, and only newer versions", () => {
		const { model } = room(scene([element("1", 2)]));
		const view = element("1", 3);
		model.put(view);
		view.version = 9;
		model.put(element("1", 1));
		expect(state(model)).toEqual(["1@3"]);
	});
});

describe("DRAWING.holds", () => {
	it("holds what the room agreed once the file has every live element at its version", () => {
		const { model } = room(drawing([element("1"), element("2", 1, true)]));
		const agreed = model.agreed();

		expect(DRAWING.holds(agreed, drawing([element("1")]))).toBe(true);
		expect(DRAWING.holds(agreed, drawing([element("1", 2)]))).toBe(false);
		expect(DRAWING.holds(agreed, drawing([element("1"), element("3")]))).toBe(
			false,
		);
		expect(DRAWING.holds(agreed, "# A note")).toBe(false);
	});
});

describe("elementsIn", () => {
	it("reads a drawing file, a scene and agreed stamps", () => {
		const elements = [element("1")];
		expect(elementsIn(drawing(elements))).toEqual(elements);
		expect(elementsIn(scene(elements))).toEqual(elements);
		expect(elementsIn(JSON.stringify(elements))).toEqual(elements);
	});

	it("has nothing for text that is no scene", () => {
		expect(elementsIn("# A note")).toBeNull();
		expect(elementsIn("{}")).toBeNull();
	});
});
