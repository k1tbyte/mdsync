import { EFrame, type ServerFrame } from "@obsync/protocol";
import { LiveHub, type TestConnection } from "@tests/helpers/live-hub";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { deriveLiveKeys, type LiveKeys } from "@/crypto/live-keys";
import { VAULT_SLOT } from "@/hub/connection";
import { docIdFor, seal } from "@/live/seal";
import { COMPACT_AFTER, LiveSession } from "@/live/session";

/** Longer than the session's batching window, so a typed edit has left. */
const FLUSHED_MS = 400;

let hub: LiveHub;
let keys: LiveKeys;
let docId: string;
const sessions: LiveSession[] = [];

beforeEach(async () => {
	hub = new LiveHub();
	keys = await deriveLiveKeys(crypto.getRandomValues(new Uint8Array(32)));
	docId = await docIdFor(keys, "note.md", 0);
});

afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
});

interface Device {
	connection: TestConnection;
	session: LiveSession;
	agreed: { text: string; seq: number } | null;
}

/** A room other than the note's first: a successor after a rotation. */
interface Room {
	doc: string;
	generation: number;
	follower?: boolean;
}

function device(
	disk: string,
	base = disk,
	room: Room = { doc: docId, generation: 0 },
): Device {
	const connection = hub.connection();
	connection.connect();
	const opened: Device = {
		connection,
		session: new LiveSession(room.doc, room.generation, {
			keys,
			hub: connection,
			person: "owner",
			follower: room.follower,
			readDisk: async () => disk,
			readBase: async () => base,
			onAgreed: (text, seq) => {
				opened.agreed = { text, seq };
			},
			onMoved: () => {},
		}),
		agreed: null,
	};
	sessions.push(opened.session);
	return opened;
}

async function synced(disk: string, base = disk, room?: Room): Promise<Device> {
	const opened = device(disk, base, room);
	await opened.session.ready;
	return opened;
}

/** Equal everywhere, and still equal once whatever was in flight has landed. */
async function converge(expected: string, ...devices: Device[]) {
	const texts = () => devices.map(({ session }) => session.text.toString());
	const all = devices.map(() => expected);
	await vi.waitFor(() => expect(texts()).toEqual(all));
	await sleep(50);
	expect(texts()).toEqual(all);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function type(target: Device, at: number, text: string): void {
	target.session.text.insert(at, text);
}

/** Another device's keystrokes, each landing in the room's log as its own delta. */
async function typedElsewhere(count: number): Promise<void> {
	const raw = hub.connection();
	raw.connect();
	raw.send({ type: EFrame.Sub, slot: VAULT_SLOT, doc: docId, since: 0 });
	const doc = new Y.Doc();
	for (let left = count; left > 0; left--) {
		const before = Y.encodeStateVector(doc);
		doc.getText("body").insert(0, "z");
		const update = Y.encodeStateAsUpdate(doc, before);
		const payload = await seal(keys, update);
		raw.send({ type: EFrame.Update, slot: VAULT_SLOT, doc: docId, payload });
	}
	raw.disconnect();
}

/** What the room hands a device opening it now. */
async function roomState(doc = docId): Promise<ServerFrame> {
	const raw = hub.connection();
	const states: ServerFrame[] = [];
	raw.listen({ onFrame: (frame) => states.push(frame) });
	raw.connect();
	raw.send({ type: EFrame.Sub, slot: VAULT_SLOT, doc, since: 0 });
	await vi.waitFor(() => expect(states.length).toBeGreaterThan(0));
	raw.disconnect();
	return states[0] as ServerFrame;
}

/** Counts the snapshots a device sends from here on. */
function snapshotsOf(target: Device): () => number {
	const send = vi.spyOn(target.connection, "send");
	return () =>
		send.mock.calls.filter(([frame]) => frame.type === EFrame.Snapshot).length;
}

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
		a.session.text.delete(1, 1);
		await sleep(FLUSHED_MS);

		const b = await synced("a\nb\nC", "a\nb\nc");

		await converge("A\nb\nC", a, b);
	});

	it("keeps both sides of a conflict, the room's first", async () => {
		const a = await synced("a\nb\nc");
		a.session.text.delete(2, 1);
		type(a, 2, "X");
		await sleep(FLUSHED_MS);

		const b = await synced("a\nY\nc", "a\nb\nc");

		await converge("a\nX\nY\nc", a, b);
	});

	it("does not resurrect a note the room emptied", async () => {
		const a = await synced("gone");
		a.session.text.delete(0, 4);
		await sleep(FLUSHED_MS);

		const b = await synced("gone");

		await converge("", a, b);
	});

	it("resends an update the wire lost once the socket comes back", async () => {
		const a = await synced("x");
		const b = await synced("x");
		a.connection.dropOutgoing();

		type(a, 1, "y");
		await sleep(FLUSHED_MS);
		expect(b.session.text.toString()).toBe("x");

		a.connection.disconnect();
		a.connection.connect();
		await converge("xy", a, b);
	});

	it("stays in step after an echo died with its socket", async () => {
		const a = await synced("x");
		const b = await synced("x");
		a.connection.dropIncoming();

		type(a, 1, "y");
		await converge("xy", b);
		a.connection.disconnect();
		a.connection.connect();
		type(a, 2, "z");

		await converge("xyz", a, b);
	});

	it("puts the text back into a room that lost its log", async () => {
		const a = await synced("keep me");
		const b = await synced("keep me");

		hub.wipe();
		a.connection.connect();
		b.connection.connect();
		await sleep(FLUSHED_MS);
		// An empty disk: the text can only come from the room.
		const c = await synced("");
		type(c, 0, "still ");

		await converge("still keep me", a, b, c);
	});

	it("agrees on a text once the room holds all of it", async () => {
		const a = await synced("x");
		const b = await synced("x");

		type(b, 1, "y");
		await converge("xy", a, b);

		await vi.waitFor(() => {
			expect(a.agreed).toEqual({ text: "xy", seq: 2 });
			expect(b.agreed).toEqual({ text: "xy", seq: 2 });
		});
	});

	it("never agrees on an edit the room has not got", async () => {
		const a = await synced("x");
		await vi.waitFor(() => expect(a.agreed).toEqual({ text: "x", seq: 1 }));
		a.connection.dropOutgoing();

		type(a, 1, "y");
		await sleep(FLUSHED_MS);

		expect(a.agreed).toEqual({ text: "x", seq: 1 });
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
		await vi.waitFor(() => expect(cursorOfA()).toMatchObject({ user: {} }));

		a.session.dispose();

		await vi.waitFor(() => expect(cursorOfA()).toBeUndefined());
	});

	it("forgets every cursor when its own socket drops", async () => {
		const a = await synced("x");
		const b = await synced("x");
		// y-protocols drops a peer's state at clock 0; any change moves it on.
		a.session.awareness.setLocalStateField("user", { name: "a" });
		await vi.waitFor(() =>
			expect(b.session.awareness.getStates().has(a.session.doc.clientID)).toBe(
				true,
			),
		);

		b.connection.disconnect();

		await vi.waitFor(() =>
			expect([...b.session.awareness.getStates().keys()]).toEqual([
				b.session.doc.clientID,
			]),
		);
	});
});

describe("live session compaction", () => {
	it("folds a long log into one snapshot a newcomer opens from", async () => {
		await typedElsewhere(COMPACT_AFTER);

		const a = await synced("");

		await vi.waitFor(async () => {
			expect(await roomState()).toMatchObject({
				head: COMPACT_AFTER,
				snapshot: expect.any(Uint8Array),
				deltas: [],
			});
		});
		const b = await synced("");
		expect(b.session.text.toString()).toBe("z".repeat(COMPACT_AFTER));
		expect(a.session.text.toString()).toBe("z".repeat(COMPACT_AFTER));
	});

	it("leaves the log alone while anything typed here is unacked", async () => {
		await typedElsewhere(COMPACT_AFTER - 1);
		const a = await synced("");
		const snapshots = snapshotsOf(a);
		a.connection.dropOutgoing();

		type(a, 0, "mine");
		await typedElsewhere(1);
		await vi.waitFor(() => expect(a.session.seq).toBe(COMPACT_AFTER));
		await sleep(FLUSHED_MS);

		expect(snapshots()).toBe(0);
	});

	it("lets only the device with the lowest client id compact", async () => {
		const a = await synced("x");
		const b = await synced("x");
		for (const { session } of [a, b]) {
			session.awareness.setLocalStateField("user", { name: "device" });
		}
		await vi.waitFor(() => {
			expect(a.session.awareness.getStates().size).toBe(2);
			expect(b.session.awareness.getStates().size).toBe(2);
		});
		const counts = [snapshotsOf(a), snapshotsOf(b)];

		await typedElsewhere(COMPACT_AFTER);
		await vi.waitFor(async () =>
			expect(await roomState()).toMatchObject({
				snapshot: expect.any(Uint8Array),
			}),
		);
		await sleep(FLUSHED_MS);

		const aLeads = a.session.doc.clientID < b.session.doc.clientID;
		expect(counts.map((count) => count())).toEqual(aLeads ? [1, 0] : [0, 1]);
	});
});

describe("live session rotation", () => {
	const next = () => docIdFor(keys, "note.md", 1);
	const successor = async (): Promise<Room> => ({
		doc: await next(),
		generation: 1,
		follower: true,
	});

	it("rebuilds the room as its successor and points every follower there", async () => {
		const a = await synced("hello");
		const b = await synced("hello");
		type(b, 5, " world");
		await converge("hello world", a, b);
		await vi.waitFor(() => expect(a.session.settled).toBe(true));

		const target = await next();
		expect(await a.session.rotate(target)).toBe("moved");

		await vi.waitFor(() => expect(b.session.movedTo).toBe(target));
		const c = await synced("hello world", "hello world", await successor());
		expect(c.session.text.toString()).toBe("hello world");
		expect(c.session.doc.getMap("users").toJSON()).toEqual({
			[String(b.session.doc.clientID)]: "owner",
		});
	});

	it("refuses once another device's edit reached the room first", async () => {
		const a = await synced("x");
		const b = await synced("x");
		await vi.waitFor(() => expect(a.session.settled).toBe(true));
		const raw = hub.connection();
		raw.connect();
		raw.send({ type: EFrame.Sub, slot: VAULT_SLOT, doc: docId, since: 0 });
		const edit = new Y.Doc();
		edit.getText("body").insert(0, "y");
		const payload = await seal(keys, Y.encodeStateAsUpdate(edit));
		const send = a.connection.send.bind(a.connection);
		vi.spyOn(a.connection, "send").mockImplementation((frame) => {
			// The keystroke lands between the rebuild and its request.
			if (frame.type === EFrame.Rotate) {
				raw.send({
					type: EFrame.Update,
					slot: VAULT_SLOT,
					doc: docId,
					payload,
				});
			}
			send(frame);
		});

		expect(await a.session.rotate(await next())).toBe("refused");

		await vi.waitFor(() => expect(b.session.text.length).toBe(2));
		await converge(b.session.text.toString(), a, b);
		expect([a.session.movedTo, (await roomState()).type]).toEqual([
			null,
			EFrame.State,
		]);
	});

	it("never seeds a successor it was pointed at", async () => {
		const c = device("from disk", "from disk", await successor());
		await sleep(FLUSHED_MS);

		expect(c.session.synced).toBe(false);
		expect(await roomState(await next())).toMatchObject({ head: 0 });
	});

	it("carries an edit the old room never took into the successor", async () => {
		const a = await synced("one");
		const b = await synced("one");
		await vi.waitFor(() => expect(b.agreed?.text).toBe("one"));
		b.connection.dropOutgoing();
		type(b, 3, " two");
		await sleep(FLUSHED_MS);

		const target = await next();
		expect(await a.session.rotate(target)).toBe("moved");
		await vi.waitFor(() => expect(b.session.movedTo).toBe(target));

		// As the manager reopens it: the editor's text against the last agreed one.
		const left = await synced("one", "one", await successor());
		const right = await synced("one two", "one", await successor());
		await converge("one two", left, right);
	});
});

describe("live session attribution", () => {
	it("names the person behind each client that typed", async () => {
		const a = await synced("x");
		const b = await synced("x");

		type(a, 1, "y");
		await converge("xy", a, b);

		expect(b.session.doc.getMap("users").toJSON()).toEqual({
			[String(a.session.doc.clientID)]: "owner",
		});
	});
});
