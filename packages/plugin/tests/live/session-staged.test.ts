import { EFrame } from "@obsync/protocol";
import {
	converge,
	FLUSHED_MS,
	OWNER,
	type,
	useLiveRoom,
	waitUntil,
} from "@tests/helpers/live-session";
import { afterEach, describe, expect, it, vi } from "vitest";

import { docIdFor } from "@/live/seal";
import { LiveSession } from "@/live/session";
import { TEXT } from "@/live/text/model";

const live = useLiveRoom();
const { synced } = live;

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const silenced = () => vi.spyOn(console, "warn").mockImplementation(() => {});

describe("live session staged edits", () => {
	it("holds a stage back to its batch and sends it as one update", async () => {
		const a = await synced("x");
		const b = await synced("x");
		await waitUntil(() => expect(a.session.settled).toBe(true));
		const send = vi.spyOn(a.connection, "send");
		const drain = vi.fn(() => type(a, 1, "y"));

		a.session.stage(drain);
		a.session.stage(drain);

		expect(a.session.settled).toBe(false);
		expect(drain).not.toHaveBeenCalled();
		await converge("xy", a, b);
		expect(drain).toHaveBeenCalledOnce();
		expect(
			send.mock.calls.filter(([frame]) => frame.type === EFrame.Update),
		).toHaveLength(1);
		await waitUntil(() => expect(a.session.settled).toBe(true));
	});

	it("agrees again after a stage that changed nothing", async () => {
		const a = await synced("x");
		await waitUntil(() => expect(a.agreed).toEqual({ text: "x", seq: 1 }));
		a.agreed = null;

		a.session.stage(() => {});
		expect(a.session.settled).toBe(false);

		await waitUntil(() => expect(a.agreed).toEqual({ text: "x", seq: 1 }));
	});

	it("flushes a stage made from inside a drain", async () => {
		const a = await synced("x");
		const b = await synced("x");

		a.session.stage(() => a.session.stage(() => type(a, 1, "y")));

		await converge("xy", a, b);
		await waitUntil(() => expect(a.session.settled).toBe(true));
	});

	it("keeps flushing after a drain threw", async () => {
		const a = await synced("x");
		const b = await synced("x");
		const warn = silenced();

		a.session.stage(() => {
			throw new Error("boom");
		});
		await waitUntil(() => expect(warn).toHaveBeenCalled());
		a.session.stage(() => type(a, 1, "y"));

		await converge("xy", a, b);
		expect(warn.mock.calls[0]?.[1]).toEqual(new Error("boom"));
	});

	it("still sends the rest and closes when a drain threw", async () => {
		const a = await synced("x");
		const b = await synced("x");
		silenced();

		a.session.stage(() => {
			throw new Error("boom");
		});
		a.session.stage(() => type(a, 1, "y"));
		a.session.dispose();

		await waitUntil(() => expect(b.session.model.text.toString()).toBe("xy"));
		expect(a.session.settled).toBe(false);
	});

	it("drains a stage on request, once", async () => {
		const a = await synced("x");
		const drain = vi.fn(() => type(a, 1, "y"));
		a.session.stage(drain);

		a.session.drainStaged();
		a.session.drainStaged();

		expect(drain).toHaveBeenCalledOnce();
		expect(a.session.model.text.toString()).toBe("xy");
	});

	it("sends a stage on disposing", async () => {
		const a = await synced("x");
		const b = await synced("x");

		a.session.stage(() => type(a, 1, "y"));
		a.session.dispose();

		await waitUntil(() => expect(b.session.model.text.toString()).toBe("xy"));
	});

	it("takes a stage in before absorbing a version", async () => {
		const a = await synced("a\nb");
		const b = await synced("a\nb");

		a.session.stage(() => type(a, 3, "\nc"));
		a.session.absorb("a\nb", "z\na\nb");

		await converge("z\na\nb\nc", a, b);
	});

	it("ignores a stage once disposed", async () => {
		const a = await synced("x");
		const drain = vi.fn();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

		a.session.dispose();
		a.session.stage(drain);
		await vi.advanceTimersByTimeAsync(FLUSHED_MS);

		expect(drain).not.toHaveBeenCalled();
	});

	it("moves a stage on with the room that lost its log", async () => {
		const a = await synced("keep me");
		const next = await docIdFor(live.keys, "note.md", 1);
		a.session.stage(() => type(a, 7, " staged"));

		live.hub.wipe();
		a.connection.connect();
		await waitUntil(() => expect(a.session.movedTo).toBe(next));

		const c = await synced("", "", { doc: next, generation: 1, knownSeq: 1 });
		expect(c.session.model.text.toString()).toBe("keep me staged");
	});

	it("takes a stage made while the successor is named into the rebuild", async () => {
		const next = await docIdFor(live.keys, "note.md", 1);
		const connection = live.hub.connection();
		connection.connect();
		const session = new LiveSession(live.docId, 0, {
			kind: TEXT,
			keys: live.keys,
			hub: connection,
			author: OWNER,
			successor: async () => {
				session.stage(() => session.model.text.insert(7, " staged"));
				return next;
			},
			readDisk: async () => "keep me",
			readBase: async () => "keep me",
			onAgreed: () => {},
			onMoved: () => {},
			onRefused: () => {},
		});
		live.sessions.push(session);
		await session.ready;

		live.hub.wipe();
		connection.connect();
		await waitUntil(() => expect(session.movedTo).toBe(next));

		const c = await synced("", "", { doc: next, generation: 1, knownSeq: 1 });
		expect(c.session.model.text.toString()).toBe("keep me staged");
	});
});
