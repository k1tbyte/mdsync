import type { EditorView, ViewUpdate } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	Awareness,
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
} from "y-protocols/awareness";
import * as Y from "yjs";

import type { LiveSession } from "@/live/session/session";
import { TextModel } from "@/live/text/model";
import { ScrollMarks } from "@/live/text/scroll-marks";

class FakeElement {
	children: FakeElement[] = [];
	attr: Record<string, string> = {};
	props: Record<string, string> = {};
	styles: Record<string, string> = {};
	clicks: Array<() => void> = [];
	removed = false;

	createDiv(options?: { attr?: Record<string, string> }): FakeElement {
		const child = new FakeElement();
		child.attr = options?.attr ?? {};
		this.children.push(child);
		return child;
	}

	empty(): void {
		this.children = [];
	}

	setCssProps(props: Record<string, string>): void {
		Object.assign(this.props, props);
	}

	setCssStyles(styles: Record<string, string>): void {
		Object.assign(this.styles, styles);
	}

	addEventListener(_type: string, listener: () => void): void {
		this.clicks.push(listener);
	}

	remove(): void {
		this.removed = true;
	}
}

const LINE = 10;
const LINE_HEIGHT = 50;

interface Measure {
	read: (view: unknown) => unknown;
	write: (marks: never) => void;
}

function setup(deferred: boolean) {
	const doc = new Y.Doc();
	const model = new TextModel(doc);
	model.text.insert(0, "x".repeat(100));
	const awareness = new Awareness(doc);
	const peers: Awareness[] = [];
	const session = {
		doc,
		model,
		awareness,
	} as unknown as LiveSession<TextModel>;

	const dom = new FakeElement();
	const dispatch = vi.fn();
	const pending: Measure[] = [];
	const view = {
		dom,
		scrollDOM: {
			scrollHeight: 1000,
			scrollTop: 0,
			getBoundingClientRect: () => ({ top: 0 }),
		},
		documentTop: 0,
		state: { doc: { length: 100 } },
		lineBlockAt: (pos: number) => ({
			top: Math.floor(pos / LINE) * LINE_HEIGHT,
		}),
		requestMeasure: vi.fn((request: Measure) => {
			if (deferred) pending.push(request);
			else request.write(request.read(view) as never);
		}),
		dispatch,
	};
	const marks = new ScrollMarks(view as unknown as EditorView, session);
	const track = () => dom.children[0] as FakeElement;

	function person(key: string, at: number) {
		const peer = new Awareness(new Y.Doc());
		peers.push(peer);
		const place = (index: number | null) => {
			peer.setLocalState(
				index === null
					? null
					: {
							user: { key, name: `${key} name` },
							cursor: {
								head: Y.relativePositionToJSON(
									Y.createRelativePositionFromTypeIndex(model.text, index),
								),
							},
						},
			);
			applyAwarenessUpdate(
				awareness,
				encodeAwarenessUpdate(peer, [peer.clientID]),
				"remote",
			);
		};
		place(at);
		return place;
	}

	const cleanup = () => {
		for (const each of [awareness, ...peers]) each.destroy();
	};
	return {
		marks,
		view,
		track,
		awareness,
		dispatch,
		pending,
		person,
		cleanup,
		scrollDOM: view.scrollDOM,
	};
}

describe("ScrollMarks", () => {
	let cleanup = () => {};
	afterEach(() => cleanup());

	function start(deferred = false) {
		const room = setup(deferred);
		cleanup = room.cleanup;
		return room;
	}

	function target(dispatch: ReturnType<typeof vi.fn>): number {
		const [spec] = dispatch.mock.calls.at(-1) ?? [];
		return (spec as { effects: { value: { range: { head: number } } } }).effects
			.value.range.head;
	}

	it("draws a tick per other cursor, down the scroll range", () => {
		const room = start();
		room.person("ann", 20);
		room.person("bob", 55);
		const ticks = room.track().children;
		expect(ticks.map((tick) => tick.attr["aria-label"])).toEqual([
			"ann name",
			"bob name",
		]);
		expect(ticks.map((tick) => tick.styles.top)).toEqual(["10.00%", "25.00%"]);
	});

	it("scrolls to the cursor of the tick clicked, not the first", () => {
		const room = start();
		room.person("ann", 20);
		room.person("bob", 55);
		room.person("cy", 80);

		room.track().children[1]?.clicks[0]?.();

		expect(target(room.dispatch)).toBe(55);
	});

	it("leaves the ticks alone when only this device's cursor moved", () => {
		const room = start();
		room.person("ann", 20);
		const measures = room.view.requestMeasure.mock.calls.length;
		const [tick] = room.track().children;

		room.awareness.setLocalStateField("cursor", { head: null });

		expect(room.view.requestMeasure.mock.calls.length).toBe(measures);
		expect(room.track().children[0]).toBe(tick);
	});

	it("keeps the same ticks while a cursor stays on its line", () => {
		const room = start();
		const move = room.person("ann", 20);
		const [tick] = room.track().children;

		move(24);

		expect(room.track().children[0]).toBe(tick);
		tick?.clicks[0]?.();
		expect(target(room.dispatch)).toBe(24);
	});

	it("keeps the same ticks when the scroll range shifts by less than a hundredth of a percent", () => {
		const room = start();
		room.person("ann", 20);
		const [tick] = room.track().children;

		room.scrollDOM.scrollHeight = 1000.02;
		room.marks.update({ geometryChanged: true } as ViewUpdate);

		expect(room.track().children[0]).toBe(tick);
	});

	it("redraws when a cursor changes line", () => {
		const room = start();
		const move = room.person("ann", 20);
		const [tick] = room.track().children;

		move(60);

		expect(room.track().children[0]).not.toBe(tick);
		expect(room.track().children[0]?.styles.top).toBe("30.00%");
	});

	it("drops the tick of a person who left", () => {
		const room = start();
		const move = room.person("ann", 20);

		move(null);

		expect(room.track().children).toEqual([]);
	});

	it("measures again when the text or the geometry changed", () => {
		const room = start();
		const measures = () => room.view.requestMeasure.mock.calls.length;
		const before = measures();

		room.marks.update({
			docChanged: false,
			geometryChanged: false,
		} as ViewUpdate);
		expect(measures()).toBe(before);
		room.marks.update({
			docChanged: true,
			geometryChanged: false,
		} as ViewUpdate);
		room.marks.update({
			docChanged: false,
			geometryChanged: true,
		} as ViewUpdate);
		expect(measures()).toBe(before + 2);
	});

	it("draws nothing from a measure queued before destroy", () => {
		const room = start(true);
		room.person("ann", 20);
		const measure = room.pending.at(-1) as Measure;
		const marks = measure.read(room.view);

		room.marks.destroy();
		measure.write(marks as never);

		expect(marks).toHaveLength(1);
		expect(measure.read(room.view)).toEqual([]);
		expect(room.track().children).toEqual([]);
	});

	it("stops listening and removes the track once destroyed", () => {
		const room = start();
		room.marks.destroy();
		const measures = room.view.requestMeasure.mock.calls.length;

		room.person("ann", 20);

		expect(room.view.requestMeasure.mock.calls.length).toBe(measures);
		expect(room.track().removed).toBe(true);
	});
});
