import {
	DRAG_FRAMES,
	DRAGGED,
	dragged,
	element,
	fakeView,
	held,
	LIB,
	NO_STALE,
	perFrameBytes,
	pointsHeld,
	room,
	STROKE,
	STROKE_FRAMES,
	STROKE_POINTS,
	state,
	stroke,
	updatesOf,
	useExcalidrawLib,
} from "@tests/helpers/drawing-view";
import { describe, expect, it, vi } from "vitest";
import type { SceneElement } from "@/drawing";
import { bindDrawing } from "@/live/drawing/binding";
import type { DrawingModel } from "@/live/drawing/model";
import type { LiveSession } from "@/live/session";

useExcalidrawLib();

describe("bindDrawing", () => {
	it("shows a stroke drawn in one view of the file in the other", () => {
		const session = room();
		const left = fakeView([element("1")]);
		const right = fakeView([element("1")]);
		bindDrawing(left.view, session, NO_STALE);
		bindDrawing(right.view, session, NO_STALE);

		left.draw(element("2"));
		session.drainStaged();

		expect(right.stamps()).toEqual(["1@1", "2@1"]);
	});

	it("lands an edit made over a newer version from elsewhere", () => {
		const session = room();
		const view = fakeView([element("1")]);
		bindDrawing(view.view, session, NO_STALE);
		session.model.elements.set("1", element("1", 5));
		view.draw({ ...element("1", 2), versionNonce: 7 });
		session.drainStaged();

		expect(held(session, "1")?.version).toBe(6);
		expect(view.stamps()).toEqual(["1@6"]);
	});

	it("neither takes nor gives elements once its view shows another file", () => {
		const session = room();
		const view = fakeView([element("1")]);
		bindDrawing(view.view, session, NO_STALE);

		view.switchTo("b.excalidraw.md", [element("b1")]);
		view.draw(element("b2"));
		session.model.put(element("3"));
		session.drainStaged();

		expect(state(session)).toEqual(["1", "3"]);
		expect(view.stamps()).toEqual(["b1@1", "b2@1"]);
	});

	it("binds nothing to a view still showing the file before", () => {
		const view = fakeView([element("1")]);
		view.view.excalidrawData = { file: null };
		expect(bindDrawing(view.view, room(), NO_STALE)).toBeNull();
	});

	it("asks for a new binding once its view replaced the API it holds", () => {
		const session = room();
		const view = fakeView([element("1")]);
		const stale = vi.fn();
		const bound = bindDrawing(view.view, session, stale);
		const reloaded = fakeView([element("1")]).view.excalidrawAPI;

		view.view.excalidrawAPI = reloaded;
		session.model.put(element("2"));

		expect(bound?.stale?.()).toBe(true);
		expect(stale).toHaveBeenCalled();
		expect(reloaded?.getSceneElementsIncludingDeleted()).toEqual([
			element("1"),
		]);
	});

	it("stops following the room once detached", () => {
		const session = room();
		const view = fakeView([element("1")]);
		bindDrawing(view.view, session, NO_STALE)?.detach();

		session.model.put(element("2"));

		expect(view.stamps()).toEqual(["1@1"]);
		expect(view.listening()).toBe(0);
	});
});

describe("bindDrawing batching", () => {
	it("puts the frames of a stroke in the room once per batch", () => {
		const session = room();
		const view = fakeView([element("1")]);
		bindDrawing(view.view, session, NO_STALE);
		const updates = updatesOf(session);

		for (const frame of STROKE) view.draw(frame);
		expect(updates).toHaveLength(0);
		session.drainStaged();

		expect(updates).toHaveLength(1);
		expect(held(session, "s")?.version).toBe(STROKE_FRAMES);
		expect(pointsHeld(session, "s")).toBe(STROKE_POINTS);
		expect(updates[0]?.length).toBeLessThan(perFrameBytes(STROKE) / 4);
	});

	it("puts every element of a drag once per batch", () => {
		const session = room();
		const view = fakeView([element("1")]);
		bindDrawing(view.view, session, NO_STALE);
		const updates = updatesOf(session);
		const frames = Array.from({ length: DRAG_FRAMES }, (_, at) =>
			dragged(at + 1),
		);

		for (const frame of frames) view.draw(...frame);
		session.drainStaged();

		expect(updates).toHaveLength(1);
		expect(state(session)).toEqual(["1", ...DRAGGED]);
		expect(DRAGGED.map((id) => held(session, id)?.version)).toEqual([
			DRAG_FRAMES + 1,
			DRAG_FRAMES + 1,
			DRAG_FRAMES + 1,
		]);
		expect(updates[0]?.length).toBeLessThan(perFrameBytes(frames.flat()) / 3);
	});

	it("takes the room's copy when the batch goes, not when the frame did", () => {
		const session = room();
		const view = fakeView([element("1")]);
		bindDrawing(view.view, session, NO_STALE);
		const live = stroke(2);

		view.draw(live);
		live.version = 3;
		session.drainStaged();
		live.points = [];

		expect(held(session, "s")?.version).toBe(3);
		expect(held(session, "s")).not.toBe(live);
		expect(pointsHeld(session, "s")).toBeGreaterThan(0);
	});

	it("puts what is staged in the room when detached", () => {
		const session = room();
		const view = fakeView([element("1")]);
		const bound = bindDrawing(view.view, session, NO_STALE);

		view.draw(element("2"));
		expect(held(session, "2")).toBeUndefined();
		bound?.detach();

		expect(held(session, "2")).toBeDefined();
	});

	it("reconciles only the keys the room changed", () => {
		const crowd = Array.from({ length: 50 }, (_, at) => element(`e${at}`));
		const session = room(crowd);
		const view = fakeView(crowd);
		bindDrawing(view.view, session, NO_STALE);
		const reconcile = vi.spyOn(LIB, "reconcileElements");
		const updates = updatesOf(session);

		session.model.elements.set("e7", element("e7", 2));

		expect(reconcile).toHaveBeenCalledOnce();
		expect(reconcile.mock.calls[0]?.[1].map(({ id }) => id)).toEqual(["e7"]);
		expect(view.stamps()).toHaveLength(50);
		expect(view.stamps()).toContain("e7@2");
		session.drainStaged();
		expect(updates).toHaveLength(1);
	});

	it("still reports an edit the view made before the room changed another element", () => {
		const scene = [element("1"), element("2")];
		const session = room(scene);
		const view = fakeView(scene);
		bindDrawing(view.view, session, NO_STALE);

		const edited = scene[1] as SceneElement;
		edited.version = 3;
		session.model.elements.set("1", element("1", 2));
		session.drainStaged();

		expect(held(session, "2")?.version).toBe(3);
	});

	it("bumps the element the view kept past the room's newer version", () => {
		const session = room();
		const view = fakeView([element("1")], { editing: ["1"] });
		bindDrawing(view.view, session, NO_STALE);

		session.model.elements.set("1", element("1", 5));
		session.drainStaged();

		expect(view.stamps()).toEqual(["1@6"]);
		expect(held(session, "1")?.version).toBe(6);
	});

	it("catches up on events it missed while its view named another file", () => {
		const session = room();
		const view = fakeView([element("1")]);
		bindDrawing(view.view, session, NO_STALE);
		const { file } = view.view;

		view.view.excalidrawData = { file: null };
		session.model.elements.set("2", element("2"));
		view.view.excalidrawData = { file };
		session.model.elements.set("3", element("3"));

		expect(view.stamps()).toEqual(["1@1", "2@1", "3@1"]);
	});

	it("sends the winner the view kept back to the room", () => {
		const session = room();
		const view = fakeView([element("1", 5)]);
		bindDrawing(view.view, session, NO_STALE);
		session.drainStaged();

		session.model.elements.set("1", element("1", 3));
		expect(view.stamps()).toEqual(["1@5"]);
		expect(held(session, "1")?.version).toBe(3);
		session.drainStaged();

		expect(held(session, "1")?.version).toBe(5);
	});
});

describe("bindDrawing pointer", () => {
	const pointer = (session: LiveSession<DrawingModel>) =>
		session.awareness.getLocalState()?.pointer;

	it("follows the pointer once per frame", () => {
		vi.useFakeTimers();
		const session = room();
		const view = fakeView([element("1")]);
		bindDrawing(view.view, session, NO_STALE);
		const change = vi.fn();
		session.awareness.on("change", change);

		view.move(1, 1);
		view.move(2, 2);
		view.move(3, 3);
		expect(change).not.toHaveBeenCalled();
		vi.advanceTimersByTime(20);

		expect(pointer(session)).toEqual({ x: 3, y: 3 });
		expect(change).toHaveBeenCalledOnce();
	});

	it("drops a frame the pointer left before", () => {
		vi.useFakeTimers();
		const session = room();
		const view = fakeView([element("1")]);
		bindDrawing(view.view, session, NO_STALE);

		view.move(1, 1);
		vi.advanceTimersByTime(20);
		view.move(2, 2);
		view.leave();
		vi.advanceTimersByTime(20);

		expect(pointer(session)).toBeNull();
	});

	it("drops a frame the binding was detached before", () => {
		vi.useFakeTimers();
		const session = room();
		const view = fakeView([element("1")]);
		const bound = bindDrawing(view.view, session, NO_STALE);

		view.move(2, 2);
		bound?.detach();
		vi.advanceTimersByTime(20);

		expect(pointer(session)).toBeNull();
	});
});
