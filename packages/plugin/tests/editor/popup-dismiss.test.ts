import type { EditorView } from "@codemirror/view";
import { FakeDocument, FakeEl } from "@tests/helpers/fake-dom";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	vi,
} from "vitest";
import { installDismissHandlers } from "@/editor/signs/popup-dismiss";

let doc: FakeDocument;
let popup: FakeEl;
let inside: FakeEl;
let scroller: FakeEl;
let dismiss: Mock<() => void>;
let cleanup: () => void;

beforeEach(() => {
	doc = new FakeDocument();
	vi.stubGlobal("document", doc);
	popup = new FakeEl("div");
	inside = popup.createEl("button");
	scroller = new FakeEl("div");
	dismiss = vi.fn<() => void>();
	cleanup = installDismissHandlers(
		{ scrollDOM: scroller } as unknown as EditorView,
		popup as unknown as HTMLElement,
		dismiss,
	);
});

afterEach(() => vi.unstubAllGlobals());

describe("installDismissHandlers", () => {
	it("dismisses on Escape and ignores other keys", () => {
		doc.fire("keydown", { key: "a" });
		expect(dismiss).not.toHaveBeenCalled();

		doc.fire("keydown", { key: "Escape" });
		expect(dismiss).toHaveBeenCalledTimes(1);
	});

	it("dismisses on a press outside the popup", () => {
		doc.fire("mousedown", { target: new FakeEl("div") });

		expect(dismiss).toHaveBeenCalledTimes(1);
	});

	it("keeps the popup for a press inside it", () => {
		doc.fire("mousedown", { target: popup });
		doc.fire("mousedown", { target: inside });

		expect(dismiss).not.toHaveBeenCalled();
	});

	it("dismisses when the editor scrolls", () => {
		scroller.fire("scroll");

		expect(dismiss).toHaveBeenCalledTimes(1);
	});

	it("removes every listener when cleaned up", () => {
		expect(doc.listenerCount("keydown")).toBe(1);
		expect(doc.listenerCount("mousedown")).toBe(1);
		expect(scroller.listenerCount("scroll")).toBe(1);

		cleanup();

		expect(doc.listenerCount("keydown")).toBe(0);
		expect(doc.listenerCount("mousedown")).toBe(0);
		expect(scroller.listenerCount("scroll")).toBe(0);
		doc.fire("keydown", { key: "Escape" });
		scroller.fire("scroll");
		expect(dismiss).not.toHaveBeenCalled();
	});
});
