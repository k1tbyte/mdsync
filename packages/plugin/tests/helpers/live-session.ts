import { EFrame, type Refusal, type ServerFrame } from "@obsync/protocol";
import { afterEach, beforeEach, expect, vi } from "vitest";
import * as Y from "yjs";

import { deriveLiveKeys, type LiveKeys } from "@/crypto/live-keys";
import { docIdFor, seal } from "@/live/seal";
import { LiveSession } from "@/live/session";
import { TEXT, type TextModel } from "@/live/text/model";
import { LiveHub, type TestConnection } from "./live-hub";

/** Longer than the session's batching window, so a typed edit has left. */
export const FLUSHED_MS = 400;
const HANG_GUARD_MS = 4_000;
export const OWNER = { person: "owner", name: "Laptop" };

export interface Device {
	connection: TestConnection;
	session: LiveSession<TextModel>;
	agreed: { text: string; seq: number } | null;
	refused: Refusal | null;
}

/** A room other than the note's first, or one this device knew further along. */
export interface Room {
	doc: string;
	generation: number;
	knownSeq?: number;
}

export function useLiveRoom() {
	const sessions: LiveSession<TextModel>[] = [];
	const live = {
		hub: new LiveHub(),
		keys: undefined as unknown as LiveKeys,
		docId: "",
		sessions,
		device,
		synced,
		typedElsewhere,
		roomState,
	};

	beforeEach(async () => {
		live.hub = new LiveHub();
		live.keys = await deriveLiveKeys(
			crypto.getRandomValues(new Uint8Array(32)),
		);
		live.docId = await docIdFor(live.keys, "note.md", 0);
	});

	afterEach(() => {
		for (const session of sessions.splice(0)) session.dispose();
	});

	function device(
		disk: string,
		base = disk,
		room: Room = { doc: live.docId, generation: 0 },
		/** Another session's socket, as a note reopened on this device. */
		shared?: TestConnection,
	): Device {
		const connection = shared ?? live.hub.connection();
		if (!shared) connection.connect();
		const opened: Device = {
			connection,
			session: new LiveSession(room.doc, room.generation, {
				kind: TEXT,
				keys: live.keys,
				hub: connection,
				author: OWNER,
				knownSeq: room.knownSeq,
				successor: () => docIdFor(live.keys, "note.md", room.generation + 1),
				readDisk: async () => disk,
				readBase: async () => base,
				onAgreed: (text, seq) => {
					opened.agreed = { text, seq };
				},
				onMoved: () => {},
				onRefused: (reason) => {
					opened.refused = reason;
				},
			}),
			agreed: null,
			refused: null,
		};
		sessions.push(opened.session);
		return opened;
	}

	async function synced(
		disk: string,
		base = disk,
		room?: Room,
	): Promise<Device> {
		const opened = device(disk, base, room);
		await opened.session.ready;
		return opened;
	}

	/** Another device's keystrokes, each landing in the room's log as its own delta. */
	async function typedElsewhere(count: number): Promise<void> {
		const raw = live.hub.connection();
		raw.connect();
		raw.send({ type: EFrame.Sub, doc: live.docId, since: 0 });
		const doc = new Y.Doc();
		for (let left = count; left > 0; left--) {
			const before = Y.encodeStateVector(doc);
			doc.getText("body").insert(0, "z");
			const update = Y.encodeStateAsUpdate(doc, before);
			const payload = await seal(live.keys, update, `doc:${live.docId}`);
			raw.send({ type: EFrame.Update, doc: live.docId, payload });
		}
		raw.disconnect();
	}

	/** What the room hands a device opening it now. */
	async function roomState(doc = live.docId): Promise<ServerFrame> {
		const raw = live.hub.connection();
		const states: ServerFrame[] = [];
		// The channel's own frames (who is here) come first.
		raw.listen({
			onFrame: (frame) => {
				if (frame.doc === doc) states.push(frame);
			},
		});
		raw.connect();
		raw.send({ type: EFrame.Sub, doc, since: 0 });
		await vi.waitFor(() => expect(states.length).toBeGreaterThan(0));
		raw.disconnect();
		return states[0] as ServerFrame;
	}

	return live;
}

/** Equal everywhere, and still equal once whatever was in flight has landed. */
export async function converge(expected: string, ...devices: Device[]) {
	const texts = () =>
		devices.map(({ session }) => session.model.text.toString());
	const all = devices.map(() => expected);
	await waitUntil(() => expect(texts()).toEqual(all));
	await sleep(50);
	expect(texts()).toEqual(all);
}

export async function waitUntil(check: () => unknown): Promise<void> {
	await vi.waitFor(check, { timeout: HANG_GUARD_MS });
}

export function reachedRoom(target: Device): Promise<void> {
	return waitUntil(() => expect(target.session.settled).toBe(true));
}

export function sentUpdate(target: Device): () => Promise<void> {
	const send = vi.spyOn(target.connection, "send");
	return () =>
		waitUntil(() =>
			expect(
				send.mock.calls.some(([frame]) => frame.type === EFrame.Update),
			).toBe(true),
		);
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function windClockUntil(done: () => void): Promise<void> {
	return vi.waitFor(
		() => {
			vi.advanceTimersByTime(FLUSHED_MS);
			done();
		},
		{ timeout: HANG_GUARD_MS, interval: 1 },
	);
}

export function textOf(target: Device): string {
	return target.session.model.text.toString();
}

export function type(target: Device, at: number, text: string): void {
	target.session.model.text.insert(at, text);
}

/** Counts the snapshots a device sends from here on. */
export function snapshotsOf(target: Device): () => number {
	const send = vi.spyOn(target.connection, "send");
	return () =>
		send.mock.calls.filter(([frame]) => frame.type === EFrame.Snapshot).length;
}
