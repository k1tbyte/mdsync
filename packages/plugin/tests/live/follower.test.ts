import { EFrame, type Refusal } from "@obsync/protocol";
import {
	FLUSHED_MS,
	sleep,
	type,
	useLiveRoom,
	waitUntil,
} from "@tests/helpers/live-session";
import { describe, expect, it, vi } from "vitest";
import {
	Awareness,
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
} from "y-protocols/awareness";
import * as Y from "yjs";

import type { SpaceFrame } from "@/hub/connection";
import { docIdFor } from "@/live/doc-id";
import { FollowerSession } from "@/live/session/follower-session";
import { FOLLOWS, RoomAwareness } from "@/live/session/room-awareness";
import type { Unfollowed } from "@/live/session/session-deps";
import { TEXT, type TextModel } from "@/live/text/model";

const live = useLiveRoom();
const { synced, roomState } = live;

interface Reader {
	session: FollowerSession<TextModel>;
	sent: () => SpaceFrame["type"][];
	cold: Unfollowed | null;
	refused: Refusal | null;
}

/** A read-only person's device; `known` are the versions the space already has. */
function reader(disk: string, known: string[] = []): Reader {
	const connection = live.hub.connection(true);
	connection.connect();
	const send = vi.spyOn(connection, "send");
	const opened: Reader = {
		sent: () => send.mock.calls.map(([frame]) => frame.type),
		cold: null,
		refused: null,
		session: new FollowerSession(live.docId, 0, {
			kind: TEXT,
			keys: live.keys,
			hub: connection,
			author: { person: "reader", name: "Reader" },
			successor: () => docIdFor(live.keys, "note.md", 1),
			readDisk: async () => disk,
			readBase: async () => disk,
			onAgreed: () => {},
			onMoved: () => {},
			onRefused: (reason) => {
				opened.refused = reason;
			},
			follower: {
				unchanged: async (text) => known.includes(text),
				onCold: (why) => {
					opened.cold = why;
				},
			},
		}),
	};
	live.sessions.push(opened.session);
	return opened;
}

const READS: SpaceFrame["type"][] = [
	EFrame.Sub,
	EFrame.Unsub,
	EFrame.Awareness,
];

describe("a read-only person's live note", () => {
	it("follows what others type and sends nothing the hub would refuse", async () => {
		const writer = await synced("hello");
		const follower = reader("hello");
		await follower.session.ready;

		type(writer, 5, " world");
		await waitUntil(() =>
			expect(follower.session.model.text.toString()).toBe("hello world"),
		);
		await sleep(FLUSHED_MS);

		expect(follower.refused).toBeNull();
		expect(follower.sent().every((sent) => READS.includes(sent))).toBe(true);
	});

	it("stays cold at a room nobody opened, which it never seeds", async () => {
		const follower = reader("hello");

		await waitUntil(() => expect(follower.cold).toBe("empty"));
		expect(await roomState()).toMatchObject({ head: 0 });
	});

	it("stays cold over changes of its own, and follows over a version the space has", async () => {
		await synced("room");

		const edited = reader("mine");
		await waitUntil(() => expect(edited.cold).toBe("diverged"));

		const behind = reader("pulled before", ["pulled before"]);
		await behind.session.ready;
		expect(behind.session.model.text.toString()).toBe("room");
		expect(behind.cold).toBeNull();
	});

	it("leaves the room at a change made here, which never reaches it", async () => {
		const writer = await synced("room");
		const follower = reader("room");
		await follower.session.ready;

		follower.session.model.text.insert(0, "x");
		await waitUntil(() => expect(follower.cold).toBe("diverged"));

		expect(follower.cold).toBe("diverged");
		expect(follower.refused).toBeNull();
		expect(writer.session.model.text.toString()).toBe("room");
		await expect(follower.session.rotate()).resolves.toBe("refused");
	});
});

describe("compaction with readers in the room", () => {
	const room = (client: number) => {
		const doc = new Y.Doc();
		doc.clientID = client;
		return new RoomAwareness(doc, {
			keys: live.keys,
			docId: live.docId,
			canSend: () => false,
			send: () => {},
			enqueue: () => {},
		});
	};

	it("is led by the lowest writer, never by a reader", () => {
		const writer = room(10);
		const peer = new Awareness(Object.assign(new Y.Doc(), { clientID: 5 }));
		peer.setLocalStateField(FOLLOWS, true);
		applyAwarenessUpdate(
			writer.awareness,
			encodeAwarenessUpdate(peer, [5]),
			"remote",
		);
		expect(writer.leads()).toBe(true);

		writer.awareness.setLocalStateField(FOLLOWS, true);
		expect(writer.leads()).toBe(false);
		peer.destroy();
		writer.dispose();
	});
});
