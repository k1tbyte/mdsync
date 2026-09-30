import { describe, expect, it } from "vitest";

import {
	CHANNEL_DOC,
	type ClientFrame,
	decodeClient,
	decodeServer,
	EFrame,
	ERefusal,
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
		note: bytes(),
		payload: Uint8Array.of(4, 2),
	},
	{
		...at,
		type: EFrame.Rotate,
		target: "next-doc-id",
		upto: 7,
		note: bytes(6, 6),
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
		log: "0f1e2d3c4b5a6978",
	},
	{ ...at, type: EFrame.State, head: 0, snapshot: null, deltas: [], log: "" },
	{ ...at, type: EFrame.Fanout, seq: 6, from: 0xdeadbeef, payload: bytes(8) },
	{ ...at, type: EFrame.Echo, seq: 6 },
	{ ...at, type: EFrame.Peer, from: 1, payload: bytes(7, 7) },
	{ ...at, type: EFrame.Join, from: 1, who: "participant-1", name: "Alex" },
	{ ...at, type: EFrame.Here, from: 2, who: "owner", name: "" },
	{ ...at, type: EFrame.Leave, from: 1 },
	{ ...at, type: EFrame.Moved, target: "next-doc-id", note: bytes() },
	{ ...at, type: EFrame.Moved, target: "next-doc-id", note: bytes(6, 6) },
	{ ...at, type: EFrame.Revoked },
	{ ...at, type: EFrame.Refused, reason: ERefusal.TooLarge },
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

	it("reads a state from a relay that sends no log", () => {
		const frame = SERVER_FRAMES[0] as ServerFrame;
		const withLog = encodeServer(frame);
		const logLength = 1 + "0f1e2d3c4b5a6978".length;

		expect(
			decodeServer(withLog.subarray(0, withLog.length - logLength)),
		).toEqual({ ...frame, log: "" });
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
