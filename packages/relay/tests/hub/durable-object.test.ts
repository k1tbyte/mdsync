import {
	type ClientFrame,
	decodeServer,
	EFrame,
	encodeClient,
	KEEPALIVE_STALE_MS,
	type ServerFrame,
} from "@mdsync/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Hub } from "../../src/hub/durable-object";
import type { Grant } from "../../src/hub/peer";
import type { HubEnv } from "../../src/hub/stub";
import { grant } from "../helpers/hub";
import { memorySql } from "../helpers/memory-sql";

const VAULT = "vault";
const SHARE = "share";
const DOC = "d".repeat(32);
const NOW = 1_000_000;
const STALE_MS = KEEPALIVE_STALE_MS;

class FakeSocket {
	readyState: number = WebSocket.OPEN;
	pinged: Date | null = null;
	closedWith: number | null = null;
	readonly sent: ServerFrame[] = [];
	attachmentReads = 0;
	private attachment: unknown;

	constructor(tag: number, joinedAt: number, slots: Grant[] = [grant(VAULT)]) {
		this.serializeAttachment({
			device: `device-${tag}`,
			slots,
			tag,
			subs: [],
			joinedAt,
		});
	}

	serializeAttachment(value: unknown): void {
		this.attachment = structuredClone(value);
	}

	deserializeAttachment(): unknown {
		this.attachmentReads++;
		return structuredClone(this.attachment);
	}

	send(bytes: Uint8Array): void {
		const frame = decodeServer(bytes);
		if (frame) this.sent.push(frame);
	}

	close(code: number): void {
		this.closedWith = code;
		this.readyState = WebSocket.CLOSING;
	}

	got(type: number): ServerFrame[] {
		return this.sent.filter((frame) => frame.type === type);
	}

	leaves(): number {
		return this.sent.filter((frame) => frame.type === EFrame.Leave).length;
	}
}

function makeHub(...sockets: FakeSocket[]) {
	let alarm: number | null = null;
	const sql = memorySql();
	const ctx = {
		setWebSocketAutoResponse() {},
		getWebSockets: () => sockets,
		getWebSocketAutoResponseTimestamp: (ws: FakeSocket) => ws.pinged,
		storage: {
			sql,
			getAlarm: async () => alarm,
			setAlarm: async (at: number) => {
				alarm = at;
			},
		},
	};
	const hub = new Hub(ctx as unknown as DurableObjectState, {} as HubEnv);
	const asSocket = (ws: FakeSocket) => ws as unknown as WebSocket;
	return {
		sql,
		message: (ws: FakeSocket, frame: ClientFrame) =>
			hub.webSocketMessage(asSocket(ws), encodeClient(frame).slice().buffer),
		purgeChannel: (channel: string) => hub.purgeChannel(channel),
		alarm: () => hub.alarm(),
		close: (ws: FakeSocket) => hub.webSocketClose(asSocket(ws)),
		error: (ws: FakeSocket) => hub.webSocketError(asSocket(ws)),
		alarmAt: () => alarm,
	};
}

beforeEach(() => {
	vi.stubGlobal("WebSocketRequestResponsePair", class {});
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("stale sweep", () => {
	it("announces a swept socket's departure once, even when its close event follows", async () => {
		const stale = new FakeSocket(1, NOW - STALE_MS - 1);
		const fresh = new FakeSocket(2, NOW);
		const hub = makeHub(stale, fresh);

		await hub.alarm();
		hub.close(stale);

		expect(stale.closedWith).toBe(1001);
		expect(fresh.closedWith).toBeNull();
		expect(fresh.leaves()).toBe(1);
	});

	it("keeps a socket whose ping is inside the window", async () => {
		const pinging = new FakeSocket(1, NOW - 10 * STALE_MS);
		pinging.pinged = new Date(NOW - 1_000);
		const hub = makeHub(pinging);

		await hub.alarm();

		expect(pinging.closedWith).toBeNull();
	});

	it("sweeps twice per window while sockets remain", async () => {
		const hub = makeHub(new FakeSocket(1, NOW));

		await hub.alarm();

		expect(hub.alarmAt()).toBe(NOW + STALE_MS / 2);
	});

	it("stops sweeping once no socket is open", async () => {
		const hub = makeHub();

		await hub.alarm();

		expect(hub.alarmAt()).toBeNull();
	});
});

describe("socket close", () => {
	it("announces once when an error is followed by a close", () => {
		const leaving = new FakeSocket(1, NOW);
		const other = new FakeSocket(2, NOW);
		const hub = makeHub(leaving, other);

		hub.error(leaving);
		hub.close(leaving);

		expect(other.leaves()).toBe(1);
	});
});

describe("frames", () => {
	it("reads each socket's attachment once, however many frames and sweeps pass", async () => {
		const sender = new FakeSocket(1, NOW);
		const follower = new FakeSocket(2, NOW);
		const hub = makeHub(sender, follower);
		const frame = (type: ClientFrame["type"], body = {}) =>
			({ type, slot: 0, doc: DOC, ...body }) as ClientFrame;
		hub.message(sender, frame(EFrame.Sub, { since: 0 }));
		hub.message(follower, frame(EFrame.Sub, { since: 0 }));

		for (let at = 0; at < 5; at++) {
			hub.message(
				sender,
				frame(EFrame.Awareness, { payload: Uint8Array.of(at) }),
			);
			hub.message(sender, frame(EFrame.Update, { payload: Uint8Array.of(at) }));
		}
		await hub.alarm();
		hub.close(sender);

		expect(follower.got(EFrame.Fanout)).toHaveLength(5);
		expect(follower.got(EFrame.Peer)).toHaveLength(5);
		expect(sender.attachmentReads).toBe(1);
		expect(follower.attachmentReads).toBe(1);
	});
});

describe("purging a channel", () => {
	it("deletes its documents, cuts its sockets and keeps the others' channels", () => {
		const owner = new FakeSocket(1, NOW, [grant(VAULT), grant(SHARE)]);
		const hub = makeHub(owner);
		const frame = (slot: number, type: ClientFrame["type"], body = {}) =>
			({ type, slot, doc: DOC, ...body }) as ClientFrame;
		for (const slot of [0, 1]) {
			hub.message(owner, frame(slot, EFrame.Sub, { since: 0 }));
			hub.message(
				owner,
				frame(slot, EFrame.Update, { payload: Uint8Array.of(1) }),
			);
		}

		hub.purgeChannel(SHARE);
		hub.message(owner, frame(1, EFrame.Update, { payload: Uint8Array.of(2) }));

		expect(owner.got(EFrame.Revoked)).toEqual([
			{ type: EFrame.Revoked, slot: 1, doc: "" },
		]);
		expect(owner.closedWith).toBeNull();
		expect(hub.sql.exec("SELECT channel, seq FROM deltas").toArray()).toEqual([
			{ channel: VAULT, seq: 1 },
		]);
		expect(hub.sql.exec("SELECT channel FROM docs").toArray()).toEqual([
			{ channel: VAULT },
		]);
		expect(hub.sql.exec("SELECT channel FROM closed").toArray()).toEqual([
			{ channel: SHARE },
		]);
	});
});
