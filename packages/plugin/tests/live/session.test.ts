import {
	EFrame,
	ERefusal,
	MAX_DOC_SUBS,
	MAX_FRAME_BYTES,
} from "@obsync/protocol";
import { TestConnection } from "@tests/helpers/live-hub";
import {
	converge,
	type Device,
	OWNER,
	reachedRoom,
	type,
	useLiveRoom,
	waitUntil,
} from "@tests/helpers/live-session";
import { describe, expect, it, vi } from "vitest";

import { closedBefore } from "@/live/closing";
import { docIdFor } from "@/live/seal";
import { LiveSession } from "@/live/session";
import { TEXT } from "@/live/text/model";

const live = useLiveRoom();
const { device, synced, roomState } = live;

describe("live session", () => {
	it("seeds an empty room from disk once when two devices open it together", async () => {
		const a = device("hello");
		const b = device("hello");

		await Promise.all([a.session.ready, b.session.ready]);

		await converge("hello", a, b);
	});

	it("keeps offline work of the device that lost the seed race", async () => {
		const a = device("hello");
		const b = device("hello world", "hello");

		await converge("hello world", a, b);
	});

	it("reopened at once on the same socket, still hears the room", async () => {
		const a = await synced("hello");
		const b = await synced("hello");
		type(a, 5, "!");
		a.session.dispose();
		// As the sessions layer opens it: after the closing one's Unsub.
		await closedBefore(live.docId);
		const again = device("hello!", "hello", undefined, a.connection);

		await again.session.ready;
		type(b, 0, ">");
		await converge(">hello!", again, b);
	});

	it("carries edits both ways", async () => {
		const a = await synced("one");
		const b = await synced("one");

		type(a, 3, " two");
		await converge("one two", a, b);
		type(b, 0, "zero ");
		await converge("zero one two", a, b);
	});

	it("folds an offline edit into the room without undoing the room's", async () => {
		const a = await synced("a\nb\nc");
		type(a, 0, "A");
		a.session.model.text.delete(1, 1);
		await reachedRoom(a);

		const b = await synced("a\nb\nC", "a\nb\nc");

		await converge("A\nb\nC", a, b);
	});

	it("keeps both sides of a conflict, the room's first", async () => {
		const a = await synced("a\nb\nc");
		a.session.model.text.delete(2, 1);
		type(a, 2, "X");
		await reachedRoom(a);

		const b = await synced("a\nY\nc", "a\nb\nc");

		await converge("a\nX\nY\nc", a, b);
	});

	it("does not resurrect a note the room emptied", async () => {
		const a = await synced("gone");
		a.session.model.text.delete(0, 4);
		await reachedRoom(a);

		const b = await synced("gone");

		await converge("", a, b);
	});

	it("moves a room that lost its log on to its next generation", async () => {
		const a = await synced("keep me");
		const b = await synced("keep me");
		const next = await docIdFor(live.keys, "note.md", 1);

		live.hub.wipe();
		a.connection.connect();
		b.connection.connect();
		await waitUntil(() => {
			expect(a.session.movedTo).toBe(next);
			expect(b.session.movedTo).toBe(next);
		});
		// An empty disk: the text can only come from the successor.
		const c = await synced("", "", { doc: next, generation: 1, knownSeq: 1 });
		type(c, 0, "still ");

		const left = await synced("keep me", "keep me", {
			doc: next,
			generation: 1,
			knownSeq: 1,
		});
		await converge("still keep me", c, left);
	});

	it("never takes a log that was lost and grew again past its seq", async () => {
		const a = await synced("x");
		const b = await synced("x");
		type(a, 1, "A");
		await converge("xA", a, b);
		b.connection.disconnect();

		live.hub.wipe();
		// A device that never knew the room seeds it again and types past b.
		const fresh = await synced("xA");
		for (const typed of ["1", "2", "3"]) {
			type(fresh, 0, typed);
			await reachedRoom(fresh);
		}
		b.connection.connect();

		const next = await docIdFor(live.keys, "note.md", 1);
		await waitUntil(() => expect(b.session.movedTo).toBe(next));
		await waitUntil(() => expect(fresh.session.movedTo).toBe(next));
		expect(b.session.model.text.toString()).toBe("xA");
		expect(await roomState(next)).toMatchObject({ head: 1 });
	});

	it("moves on from an empty room it knew had a log", async () => {
		const opened = device("from disk", "from disk", {
			doc: live.docId,
			generation: 0,
			knownSeq: 3,
		});
		const next = await docIdFor(live.keys, "note.md", 1);

		await waitUntil(() => expect(opened.session.movedTo).toBe(next));
		const successor = await synced("", "", {
			doc: next,
			generation: 1,
			knownSeq: 1,
		});
		expect(successor.session.model.text.toString()).toBe("from disk");
	});

	it("follows a successor that already has a log rather than seeding it", async () => {
		const next = await docIdFor(live.keys, "note.md", 1);
		await synced("theirs", "theirs", { doc: next, generation: 1 });

		const late = device("mine", "mine", {
			doc: live.docId,
			generation: 0,
			knownSeq: 5,
		});

		await waitUntil(() => expect(late.session.movedTo).toBe(next));
		expect(await roomState(next)).toMatchObject({ head: 1 });
	});

	it("goes cold on a document too large for a frame, sending none of it", async () => {
		const sent = vi.spyOn(TestConnection.prototype, "send");
		const huge = device("x".repeat(MAX_FRAME_BYTES));

		await waitUntil(() => expect(huge.refused).toBe(ERefusal.TooLarge));
		expect(sent.mock.calls.map(([frame]) => frame.type)).toEqual([EFrame.Sub]);
		expect(huge.session.synced).toBe(false);
		sent.mockRestore();
	});

	it("goes cold when the hub refuses to follow one more document", async () => {
		const full = live.hub.connection();
		full.connect();
		for (let at = 0; at < MAX_DOC_SUBS; at++) {
			full.send({ type: EFrame.Sub, doc: `doc-${at}`, since: 0 });
		}
		const opened: Device = {
			connection: full,
			session: new LiveSession(live.docId, 0, {
				kind: TEXT,
				keys: live.keys,
				hub: full,
				author: OWNER,
				successor: () => docIdFor(live.keys, "note.md", 1),
				readDisk: async () => "x",
				readBase: async () => "x",
				onAgreed: () => {},
				onMoved: () => {},
				onRefused: (reason) => {
					opened.refused = reason;
				},
			}),
			agreed: null,
			refused: null,
		};
		live.sessions.push(opened.session);

		await waitUntil(() => expect(opened.refused).toBe(ERefusal.TooManyDocs));
	});

	it("agrees on a text once the room holds all of it", async () => {
		const a = await synced("x");
		const b = await synced("x");

		type(b, 1, "y");
		await converge("xy", a, b);

		await waitUntil(() => {
			expect(a.agreed).toEqual({ text: "xy", seq: 2 });
			expect(b.agreed).toEqual({ text: "xy", seq: 2 });
		});
	});

	it("keeps what an editor typed while the room was answering", async () => {
		const a = await synced("a\nb");
		const b = await synced("a\nb");

		b.session.adopt("a\nb\ntyped");

		await converge("a\nb\ntyped", a, b);
	});

	it("folds in only the first editor, not one that lags the room", async () => {
		const a = await synced("a\nb");
		const b = await synced("a\nb");
		a.session.adopt("a\nb");
		type(b, 3, "\nc\nd");
		await converge("a\nb\nc\nd", a, b);

		a.session.adopt("a\nb\nc");

		await converge("a\nb\nc\nd", a, b);
	});

	it("drops a departed device's cursor at once", async () => {
		const a = await synced("x");
		const b = await synced("x");
		a.session.awareness.setLocalStateField("user", { name: "a" });
		const cursorOfA = () =>
			b.session.awareness.getStates().get(a.session.doc.clientID);
		await waitUntil(() => expect(cursorOfA()).toMatchObject({ user: {} }));

		a.session.dispose();

		await waitUntil(() => expect(cursorOfA()).toBeUndefined());
	});

	it("forgets every cursor when its own socket drops", async () => {
		const a = await synced("x");
		const b = await synced("x");
		// y-protocols drops a peer's state at clock 0; any change moves it on.
		a.session.awareness.setLocalStateField("user", { name: "a" });
		await waitUntil(() =>
			expect(b.session.awareness.getStates().has(a.session.doc.clientID)).toBe(
				true,
			),
		);

		b.connection.disconnect();

		await waitUntil(() =>
			expect([...b.session.awareness.getStates().keys()]).toEqual([
				b.session.doc.clientID,
			]),
		);
	});
});
