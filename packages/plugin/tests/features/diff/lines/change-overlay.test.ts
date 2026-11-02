// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { installElementMethods } from "@tests/helpers/element-methods";
import { installElementFactories } from "@tests/helpers/obsidian-dom";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CompareSegment } from "@/features/diff/compare/compare-decorations";
import { ChangeOverlay } from "@/features/diff/lines/change-overlay";

beforeAll(() => {
	installElementFactories();
	installElementMethods();
});

const views: EditorView[] = [];
// A live view measures in a later frame, which jsdom cannot.
afterEach(() => {
	for (const view of views.splice(0)) view.destroy();
});

/** Line 2 of the left side, kept or deleted on the right. */
const change = (right: [number, number]): CompareSegment => ({
	key: 0,
	hunk: 0,
	segment: 0,
	left: [1, 2],
	right,
	removed: 1,
	added: right[1] - right[0],
	leftText: ["gone"],
	rightText: [],
	leftMarks: () => [],
	rightMarks: () => [],
});

function pane() {
	const host = document.body.createDiv();
	// jsdom lays nothing out, and a pane of no height runs no ring.
	Object.defineProperty(host, "clientHeight", { value: 400 });
	const view = new EditorView({
		state: EditorState.create({ doc: "a\nb\nc" }),
		parent: host,
	});
	views.push(view);
	const overlay = new ChangeOverlay(host, view, "right", () => {});
	const rings = () => host.querySelectorAll<HTMLElement>(".mdsync-change-ring");
	return { overlay, rings };
}

describe("ChangeOverlay ring", () => {
	it("draws nothing until a layout places it", () => {
		const { overlay, rings } = pane();
		const segment = change([1, 2]);
		overlay.flash(segment);
		expect(rings()).toHaveLength(0);
		overlay.layout([segment], new Set());
		expect(rings()).toHaveLength(1);
	});
});
