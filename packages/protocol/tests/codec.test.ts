import { describe, expect, it } from "vitest";

import {
	CHANNEL_DOC,
	type ClientFrame,
	decodeClient,
	decodeServer,
	EFrame,
	encodeClient,
	encodeServer,
	type ServerFrame,
	withSlot,
} from "../src/index";

const bytes = (...values: number[]) => Uint8Array.from(values);
const at = { slot: 3, doc: "doc-id" };

const CLIENT_FRAMES: ClientFrame[] = [
	{ ...at, type: EFrame.Sub, since: 42 },
	{ ...at, type: EFrame.Unsub },
	{ ...at, type: EFrame.Update, payload: bytes(1, 2, 3) },
	{ ...at, type: EFrame.Awareness, payload: bytes(9) },
	{ ...at, type: EFrame.Snapshot, upto: 7, payload: bytes(4, 5) },
	{
		...at,
		type: EFrame.Rotate,
		target: "next-doc-id",
		upto: 7,
		payload: Uint8Array.of(4, 2),
	},
	{ ...at, type: EFrame.Seed, payload: Uint8Array.of(4, 2) },
	{ slot: 0, doc: CHANNEL_DOC, type: EFrame.Signal },
];

const SERVER_FRAMES: ServerFrame[] = [
	{
		...at,
		type: EFrame.State,
		head: 5,
		snapshot: bytes(1),
		deltas: [bytes(2), bytes(3, 4)],
	},
	{ ...at, type: EFrame.State, head: 0, snapshot: null, deltas: [] },
	{ ...at, type: EFrame.Fanout, seq: 6, from: 0xdeadbeef, payload: bytes(8) },
	{ ...at, type: EFrame.Echo, seq: 6 },
	{ ...at, type: EFrame.Peer, from: 1, payload: bytes(7, 7) },
	{ ...at, type: EFrame.Join, from: 1, who: "participant-1" },
	{ ...at, type: EFrame.Leave, from: 1 },
	{ ...at, type: EFrame.Moved, target: "next-doc-id" },
	{ ...at, type: EFrame.Revoked },
	{ slot: 1, doc: CHANNEL_DOC, type: EFrame.Signal, from: 9 },
];

describe("codec", () => {
	it.each(CLIENT_FRAMES)("round-trips client frame $type", (frame) => {
		expect(decodeClient(encodeClient(frame))).toEqual(frame);
	});

	it.each(SERVER_FRAMES)("round-trips server frame $type", (frame) => {
		expect(decodeServer(encodeServer(frame))).toEqual(frame);
	});

	it("rejects malformed input instead of throwing", () => {
		const update = encodeClient(CLIENT_FRAMES[2] as ClientFrame);
		expect(decodeClient(new Uint8Array())).toBeNull();
		expect(decodeClient(bytes(99, 0, 0))).toBeNull();
		expect(decodeClient(update.subarray(0, 4))).toBeNull();
		expect(
			decodeServer(
				encodeServer(SERVER_FRAMES[0] as ServerFrame).subarray(0, 12),
			),
		).toBeNull();
	});

	it("does not decode a server frame as a client one", () => {
		expect(
			decodeClient(encodeServer(SERVER_FRAMES[3] as ServerFrame)),
		).toBeNull();
	});

	it("readdresses a frame to another slot and nothing else", () => {
		const frame = SERVER_FRAMES[2] as ServerFrame;
		const original = encodeServer(frame);
		const moved = withSlot(original, 9);
		expect(decodeServer(moved)).toEqual({ ...frame, slot: 9 });
		expect(original[1]).toBe(frame.slot);
	});

	it("refuses a doc id longer than its length byte", () => {
		expect(() =>
			encodeClient({ slot: 0, doc: "x".repeat(256), type: EFrame.Unsub }),
		).toThrow();
	});
});
