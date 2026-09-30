import { EFrame } from "@obsync/protocol";
import {
	converge,
	FLUSHED_MS,
	OWNER,
	type Room,
	sentUpdate,
	sleep,
	snapshotsOf,
	type,
	useLiveRoom,
	waitUntil,
} from "@tests/helpers/live-session";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { seal } from "@/crypto/seal";
import { docIdFor } from "@/live/doc-id";
import { COMPACT_AFTER } from "@/live/session/room-log";

const live = useLiveRoom();
const { device, synced, typedElsewhere, roomState } = live;

describe("live session rotation", () => {
	it("answers busy when the rebuild cannot be sealed, rather than never", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const a = await synced("text");
		const encrypt = vi
			.spyOn(crypto.subtle, "encrypt")
			.mockRejectedValueOnce(new Error("sealing failed"));

		const outcome = await a.session.rotate(
			await docIdFor(live.keys, "note.md", 1),
		);

		expect(outcome).toBe("busy");
		encrypt.mockRestore();
		warn.mockRestore();
	});
});

describe("live session compaction", () => {
	it("folds a long log into one snapshot a newcomer opens from", async () => {
		await typedElsewhere(COMPACT_AFTER);

		const a = await synced("");

		await waitUntil(async () => {
			expect(await roomState()).toMatchObject({
				head: COMPACT_AFTER,
				snapshot: expect.any(Uint8Array),
				deltas: [],
			});
		});
		const b = await synced("");
		expect(b.session.model.text.toString()).toBe("z".repeat(COMPACT_AFTER));
		expect(a.session.model.text.toString()).toBe("z".repeat(COMPACT_AFTER));
	});

	it("leaves the log alone while anything typed here is unacked", async () => {
		await typedElsewhere(COMPACT_AFTER - 1);
		const a = await synced("");
		const snapshots = snapshotsOf(a);
		a.connection.dropOutgoing();
		const updateSent = sentUpdate(a);

		type(a, 0, "mine");
		await typedElsewhere(1);
		await waitUntil(() => expect(a.session.seq).toBe(COMPACT_AFTER));
		await updateSent();
		await sleep(FLUSHED_MS);

		expect(snapshots()).toBe(0);
	});

	it("lets only the device with the lowest client id compact", async () => {
		const a = await synced("x");
		const b = await synced("x");
		for (const { session } of [a, b]) {
			session.awareness.setLocalStateField("user", { name: "device" });
		}
		await waitUntil(() => {
			expect(a.session.awareness.getStates().size).toBe(2);
			expect(b.session.awareness.getStates().size).toBe(2);
		});
		const counts = [snapshotsOf(a), snapshotsOf(b)];

		await typedElsewhere(COMPACT_AFTER);
		await waitUntil(async () =>
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
	const next = () => docIdFor(live.keys, "note.md", 1);
	const successor = async (): Promise<Room> => ({
		doc: await next(),
		generation: 1,
		knownSeq: 1,
	});

	it("rebuilds the room as its successor and points every follower there", async () => {
		const a = await synced("hello");
		const b = await synced("hello");
		type(b, 5, " world");
		await converge("hello world", a, b);
		await waitUntil(() => expect(a.session.settled).toBe(true));

		const target = await next();
		expect(await a.session.rotate(target)).toBe("moved");

		await waitUntil(() => expect(b.session.movedTo).toBe(target));
		const c = await synced("hello world", "hello world", await successor());
		expect(c.session.model.text.toString()).toBe("hello world");
		expect(c.session.doc.getMap("users").toJSON()).toEqual({
			[String(b.session.doc.clientID)]: OWNER,
		});
	});

	it("refuses once another device's edit reached the room first", async () => {
		const a = await synced("x");
		const b = await synced("x");
		await waitUntil(() => expect(a.session.settled).toBe(true));
		const raw = live.hub.connection();
		raw.connect();
		raw.send({ type: EFrame.Sub, doc: live.docId, since: 0 });
		const edit = new Y.Doc();
		edit.getText("body").insert(0, "y");
		const payload = await seal(
			live.keys,
			Y.encodeStateAsUpdate(edit),
			`doc:${live.docId}`,
		);
		const send = a.connection.send.bind(a.connection);
		vi.spyOn(a.connection, "send").mockImplementation((frame) => {
			// The keystroke lands between the rebuild and its request.
			if (frame.type === EFrame.Rotate) {
				raw.send({
					type: EFrame.Update,
					doc: live.docId,
					payload,
				});
			}
			send(frame);
		});

		expect(await a.session.rotate(await next())).toBe("refused");

		await waitUntil(() => expect(b.session.model.text.length).toBe(2));
		await converge(b.session.model.text.toString(), a, b);
		expect([a.session.movedTo, (await roomState()).type]).toEqual([
			null,
			EFrame.State,
		]);
	});

	it("moves on from a successor it was pointed at but finds empty", async () => {
		const c = device("from disk", "from disk", await successor());
		const after = await docIdFor(live.keys, "note.md", 2);

		await waitUntil(() => expect(c.session.movedTo).toBe(after));
		expect(c.session.synced).toBe(false);
		expect(await roomState(after)).toMatchObject({ head: 1 });
	});

	it("carries an edit the old room never took into the successor", async () => {
		const a = await synced("one");
		const b = await synced("one");
		await waitUntil(() => expect(b.agreed?.text).toBe("one"));
		b.connection.dropOutgoing();
		const updateSent = sentUpdate(b);
		type(b, 3, " two");
		await updateSent();

		const target = await next();
		expect(await a.session.rotate(target)).toBe("moved");
		await waitUntil(() => expect(b.session.movedTo).toBe(target));

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
			[String(a.session.doc.clientID)]: OWNER,
		});
	});
});
