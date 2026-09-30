import { EFrame } from "@obsync/protocol";
import {
	element,
	fakeView,
	held,
	NO_STALE,
	perFrameBytes,
	STROKE,
	useExcalidrawLib,
} from "@tests/helpers/drawing-view";
import { LiveHub } from "@tests/helpers/live-hub";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deriveLiveKeys } from "@/crypto/live-keys";
import type { SceneElement } from "@/drawing";
import { bindDrawing } from "@/live/drawing/binding";
import { DRAWING, type DrawingModel } from "@/live/drawing/model";
import { docIdFor } from "@/live/seal";
import { LiveSession } from "@/live/session";

useExcalidrawLib();

const sessions: LiveSession<DrawingModel>[] = [];

afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
});

async function settledDrawing(elements: SceneElement[]) {
	const hub = new LiveHub();
	const keys = await deriveLiveKeys(crypto.getRandomValues(new Uint8Array(32)));
	const connection = hub.connection();
	connection.connect();
	const disk = JSON.stringify(elements);
	const session = new LiveSession(
		await docIdFor(keys, "a.excalidraw.md", 0),
		0,
		{
			kind: DRAWING,
			keys,
			hub: connection,
			author: { person: "owner", name: "Laptop" },
			successor: async () => "next",
			readDisk: async () => disk,
			readBase: async () => disk,
			onAgreed() {},
			onMoved() {},
			onRefused() {},
		},
	);
	sessions.push(session);
	await session.ready;
	await vi.waitFor(() => expect(session.settled).toBe(true));
	return { session, connection };
}

describe("bindDrawing over a live session", () => {
	it("sends the frames of a stroke as one update", async () => {
		const { session, connection } = await settledDrawing([element("1")]);
		const view = fakeView([element("1")]);
		bindDrawing(view.view, session, NO_STALE);
		const send = vi.spyOn(connection, "send");

		for (const frame of STROKE) view.draw(frame);
		expect(session.settled).toBe(false);
		await vi.waitFor(() => expect(session.settled).toBe(true));

		const sent = send.mock.calls
			.map(([frame]) => frame)
			.filter((frame) => frame.type === EFrame.Update);
		expect(sent).toHaveLength(1);
		const [update] = sent;
		expect(
			update?.type === EFrame.Update && update.payload.length,
		).toBeLessThan(perFrameBytes(STROKE) / 4);
	});

	it("settles two views of one file that edited one element together", async () => {
		const { session } = await settledDrawing([element("1")]);
		const left = fakeView([element("1")]);
		const right = fakeView([element("1")]);
		bindDrawing(left.view, session, NO_STALE);
		bindDrawing(right.view, session, NO_STALE);

		left.draw(element("1", 3));
		right.draw(element("1", 5));
		expect(session.settled).toBe(false);
		await vi.waitFor(() => expect(session.settled).toBe(true), {
			timeout: 2000,
		});

		expect(left.stamps()).toEqual(["1@5"]);
		expect(right.stamps()).toEqual(["1@5"]);
		expect(held(session, "1")?.version).toBe(5);
	});
});
