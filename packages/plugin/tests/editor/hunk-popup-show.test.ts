import { Chunk } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { FakeDocument, FakeEl } from "@tests/helpers/fake-dom";
import { FakeModal } from "@tests/helpers/fake-obsidian-dom";
import { Platform } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toCmText } from "@/editor/signs/helpers";
import { dismissPopup, showHunkPopupAt } from "@/editor/signs/hunk-popup";
import type { SignsProvider } from "@/editor/signs/provider";
import {
	chunksField,
	compareTextField,
	setChunksEffect,
	setCompareTextEffect,
} from "@/editor/signs/state";

vi.mock("obsidian", async (importOriginal) =>
	(await import("@tests/helpers/fake-obsidian-dom")).fakeObsidian(
		await importOriginal(),
	),
);
vi.mock("@/ui/common/notices", () => ({ notifyInfo: vi.fn() }));

const BASELINE = "one\ntwo\nthree\n";
const CURRENT = "one\nTWO\nthree\n";
const CLICK = { clientX: 10, clientY: 20 } as MouseEvent;

let doc: FakeDocument;
let scroller: FakeEl;
let view: EditorView;
let provider: SignsProvider;

function editorView(): EditorView {
	const baseline = toCmText(BASELINE);
	const opened = EditorState.create({
		doc: CURRENT,
		extensions: [compareTextField, chunksField],
	}).update({ effects: setCompareTextEffect.of(baseline) }).state;
	const state = opened.update({
		effects: setChunksEffect.of({
			chunks: Chunk.build(baseline, opened.doc),
			lastDiffMs: 0,
		}),
	}).state;
	return {
		state,
		scrollDOM: scroller,
		dispatch: vi.fn(),
	} as unknown as EditorView;
}

const popupsIn = (root: FakeEl) =>
	root.find((el) => el.hasClass("obsync-hunk-popup"));

beforeEach(() => {
	doc = new FakeDocument();
	scroller = new FakeEl("div");
	vi.stubGlobal("document", doc);
	vi.stubGlobal("innerWidth", 1000);
	vi.stubGlobal("innerHeight", 800);
	view = editorView();
	provider = {
		app: {},
		getViewPath: () => "note.md",
		pushHunk: vi.fn(async () => {}),
	} as unknown as SignsProvider;
});

afterEach(() => {
	dismissPopup();
	Platform.isPhone = false;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("showHunkPopupAt on desktop", () => {
	it("floats the popup over the page and listens for a way out", () => {
		expect(showHunkPopupAt(view, 2, CLICK, provider)).toBe(true);

		expect(popupsIn(doc.body)).toHaveLength(1);
		expect(doc.listenerCount("keydown")).toBe(1);
		expect(doc.listenerCount("mousedown")).toBe(1);
		expect(scroller.listenerCount("scroll")).toBe(1);
	});

	it("takes the popup and every listener away on Escape", () => {
		showHunkPopupAt(view, 2, CLICK, provider);

		doc.fire("keydown", { key: "Escape" });

		expect(popupsIn(doc.body)).toHaveLength(0);
		expect(doc.listenerCount("keydown")).toBe(0);
		expect(doc.listenerCount("mousedown")).toBe(0);
		expect(scroller.listenerCount("scroll")).toBe(0);
	});

	it("shows one popup at a time", () => {
		showHunkPopupAt(view, 2, CLICK, provider);
		showHunkPopupAt(view, 2, CLICK, provider);

		expect(popupsIn(doc.body)).toHaveLength(1);
		expect(doc.listenerCount("keydown")).toBe(1);
	});

	it("says no when the line is in no change", () => {
		expect(showHunkPopupAt(view, 3, CLICK, provider)).toBe(false);
		expect(popupsIn(doc.body)).toHaveLength(0);
	});
});

describe("showHunkPopupAt on a phone", () => {
	let closeSpy: ReturnType<typeof vi.spyOn>;
	let openSpy: ReturnType<typeof vi.spyOn>;
	const drawers = () => openSpy.mock.contexts as FakeModal[];

	beforeEach(() => {
		Platform.isPhone = true;
		closeSpy = vi.spyOn(FakeModal.prototype, "close");
		openSpy = vi.spyOn(FakeModal.prototype, "open");
	});

	it("opens a bottom drawer with the popup in it, not one over the page", () => {
		expect(showHunkPopupAt(view, 2, CLICK, provider)).toBe(true);

		const [drawer] = drawers();
		expect(drawers()).toHaveLength(1);
		expect(popupsIn(doc.body)).toHaveLength(0);
		expect(drawer?.containerEl.hasClass("obsync-hunk-drawer-container")).toBe(
			true,
		);
		expect(drawer?.modalEl.hasClass("obsync-hunk-drawer")).toBe(true);
		expect(popupsIn(drawer?.contentEl as FakeEl)).toHaveLength(1);
		expect(doc.listenerCount("mousedown")).toBe(0);
	});

	it("closes the drawer from the Close button in its header", () => {
		showHunkPopupAt(view, 2, CLICK, provider);
		const [drawer] = drawers();
		const close = popupsIn(drawer?.contentEl as FakeEl)[0]?.find(
			(el) => el.attrs.get("aria-label") === "Close",
		)[0];

		close?.fire("click");

		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(drawer?.contentEl.children).toEqual([]);
	});

	it("closes the drawer when another change is opened", () => {
		showHunkPopupAt(view, 2, CLICK, provider);
		showHunkPopupAt(view, 2, CLICK, provider);

		expect(drawers()).toHaveLength(2);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(closeSpy.mock.contexts[0]).toBe(drawers()[0]);
	});

	it("forgets a drawer that closed on its own, so dismissing does not close it twice", () => {
		showHunkPopupAt(view, 2, CLICK, provider);
		const [drawer] = drawers();

		drawer?.close();
		dismissPopup();

		expect(closeSpy).toHaveBeenCalledTimes(1);
	});

	it("closes the drawer for good on dismiss", () => {
		showHunkPopupAt(view, 2, CLICK, provider);

		dismissPopup();
		dismissPopup();

		expect(closeSpy).toHaveBeenCalledTimes(1);
	});
});
