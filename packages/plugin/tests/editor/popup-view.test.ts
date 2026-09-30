import { Chunk } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { FakeDocument, type FakeEl } from "@tests/helpers/fake-dom";
import { Platform } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toCmText } from "@/editor/signs/helpers";
import { buildPopup, type HunkTarget } from "@/editor/signs/popup-view";
import type { SignsProvider } from "@/editor/signs/provider";
import { computeHunks } from "@/sync/hunks";
import { notifyInfo } from "@/ui/common/notices";

vi.mock("obsidian", async (importOriginal) =>
	(await import("@tests/helpers/fake-obsidian-dom")).fakeObsidian(
		await importOriginal(),
	),
);
vi.mock("@/ui/common/notices", () => ({ notifyInfo: vi.fn() }));

const BASELINE = "one\ntwo\nthree\n";
const CURRENT = "one\nTWO\nthree\n";

function makeTarget(current = CURRENT, path: string | null = "note.md") {
	const baseline = toCmText(BASELINE);
	const doc = toCmText(current);
	const chunk = Chunk.build(baseline, doc)[0];
	const syncHunk = computeHunks(BASELINE, current).hunks[0];
	if (!chunk || !syncHunk) throw new Error("no change");
	const state = { doc };
	const dispatch = vi.fn();
	const pushHunk = vi.fn(async () => {});
	const target: HunkTarget = {
		view: { state, dispatch } as unknown as EditorView,
		chunk,
		baseline,
		provider: { pushHunk } as unknown as SignsProvider,
		path,
		syncHunk,
	};
	return { target, state, dispatch, pushHunk, syncHunk };
}

const build = (target: HunkTarget, dismiss = vi.fn()) => ({
	popup: buildPopup(target, dismiss) as unknown as FakeEl,
	dismiss,
});
const buttonsOf = (popup: FakeEl) => popup.find((el) => el.tag === "button");
const buttonNamed = (popup: FakeEl, text: string) => {
	const found = popup.find(
		(el) =>
			el.tag === "button" && (el.text === text || el.textContent === text),
	)[0];
	if (!found) throw new Error(`no "${text}" button`);
	return found;
};
const body = (popup: FakeEl) =>
	popup.find((el) => el.hasClass("obsync-hunk-popup-body"))[0] as FakeEl;
const resultOf = (dispatch: ReturnType<typeof vi.fn>) =>
	EditorState.create({ doc: toCmText(CURRENT) })
		.update(dispatch.mock.calls[0]?.[0])
		.state.doc.toString();

beforeEach(() => {
	vi.stubGlobal("document", new FakeDocument());
	vi.clearAllMocks();
});

afterEach(() => {
	Platform.isPhone = false;
	vi.unstubAllGlobals();
});

describe("buildPopup header", () => {
	it("names the dialog after what changed", () => {
		const { popup } = build(makeTarget().target);

		expect(popup.attrs.get("role")).toBe("dialog");
		expect(popup.attrs.get("aria-label")).toBe("Changes since last sync");
		expect(popup.textContent).toContain("Changes since last sync");
	});

	it("closes through an icon button labelled Close, not a text glyph", () => {
		const { popup, dismiss } = build(makeTarget().target);
		const close = popup.find((el) => el.attrs.get("aria-label") === "Close")[0];

		expect(close?.tag).toBe("button");
		expect(close?.hasClass("obsync-icon-btn")).toBe(true);
		expect(close?.textContent).toBe("");
		close?.fire("click");

		expect(dismiss).toHaveBeenCalledTimes(1);
	});

	it("shows Wrap as a toggle that says whether it is on", () => {
		const { popup } = build(makeTarget().target);
		const wrap = buttonNamed(popup, "Wrap");

		expect(wrap.hasClass("obsync-labeled-btn")).toBe(true);
		expect(wrap.attrs.get("aria-pressed")).toBe("false");
		expect(body(popup).hasClass("is-wrapped")).toBe(false);

		wrap.fire("click");
		expect(wrap.attrs.get("aria-pressed")).toBe("true");
		expect(body(popup).hasClass("is-wrapped")).toBe(true);

		wrap.fire("click");
		expect(wrap.attrs.get("aria-pressed")).toBe("false");
		expect(body(popup).hasClass("is-wrapped")).toBe(false);
	});

	it("starts wrapped on a phone", () => {
		Platform.isPhone = true;
		const { popup } = build(makeTarget().target);

		expect(buttonNamed(popup, "Wrap").attrs.get("aria-pressed")).toBe("true");
		expect(body(popup).hasClass("is-wrapped")).toBe(true);
	});
});

describe("buildPopup body", () => {
	it("shows removed lines, then added ones, each with its sign", () => {
		const { popup } = build(makeTarget().target);
		const rows = body(popup).children.map((row) => row.textContent);

		expect(rows).toEqual(["-two", "+TWO"]);
	});

	it("cuts a long hunk short and says how many lines it left out", () => {
		const many = Array.from({ length: 35 }, (_, i) => `line ${i}`).join("\n");
		const baseline = toCmText("start\n");
		const doc = toCmText(`start\n${many}\n`);
		const chunk = Chunk.build(baseline, doc)[0];
		const syncHunk = computeHunks("start\n", `start\n${many}\n`).hunks[0];
		if (!chunk) throw new Error("no change");
		const { popup } = build({
			...makeTarget().target,
			view: { state: { doc }, dispatch: vi.fn() } as unknown as EditorView,
			chunk,
			baseline,
			syncHunk: syncHunk ?? null,
		});
		const rows = body(popup).children;

		expect(rows).toHaveLength(31);
		expect(rows.at(-1)?.text).toBe("… 5 more line(s)");
	});
});

describe("buildPopup footer", () => {
	it("pushes the hunk it showed, with the note as it is, and dismisses", () => {
		const { target, pushHunk, syncHunk } = makeTarget();
		const { popup, dismiss } = build(target);

		buttonNamed(popup, "Push hunk").fire("click");

		expect(pushHunk).toHaveBeenCalledWith("note.md", syncHunk, CURRENT);
		expect(dismiss).toHaveBeenCalledTimes(1);
	});

	it("offers no push for a note with no path", () => {
		const { popup } = build(makeTarget(CURRENT, null).target);

		expect(buttonsOf(popup).map((el) => el.text)).not.toContain("Push hunk");
		expect(buttonsOf(popup).map((el) => el.text)).toContain("Revert hunk");
	});

	it("reverts the hunk to the last synced text and dismisses", () => {
		const { target, dispatch } = makeTarget();
		const { popup, dismiss } = build(target);

		buttonNamed(popup, "Revert hunk").fire("click");

		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(resultOf(dispatch)).toBe(BASELINE);
		expect(dismiss).toHaveBeenCalledTimes(1);
	});

	it("refuses to push or revert once the note has changed under the popup", () => {
		const { target, state, dispatch, pushHunk } = makeTarget();
		const { popup, dismiss } = build(target);
		state.doc = toCmText(`${CURRENT}remote edit\n`);

		buttonNamed(popup, "Push hunk").fire("click");
		buttonNamed(popup, "Revert hunk").fire("click");

		expect(pushHunk).not.toHaveBeenCalled();
		expect(dispatch).not.toHaveBeenCalled();
		expect(notifyInfo).toHaveBeenCalledWith(
			"The note changed. Open the change again.",
		);
		expect(dismiss).toHaveBeenCalledTimes(2);
	});
});
