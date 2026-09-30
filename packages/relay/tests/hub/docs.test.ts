import {
	type ClientFrame,
	EFrame,
	ERefusal,
	MAX_DOC_SUBS,
	MAX_MOVE_NOTE_BYTES,
	type ServerFrame,
} from "@obsync/protocol";
import { describe, expect, it } from "vitest";

import { HubCore } from "../../src/hub/core";
import { type Sql, SqlDocStore } from "../../src/hub/store";
import { type FakePeer, grant, hub, peer, send, types } from "../helpers/hub";
import { memorySql } from "../helpers/memory-sql";

const VAULT = "vault-channel";
const OTHER = "other-channel";
const DOC = "a".repeat(32);
const NEXT = "b".repeat(32);
const LOG = expect.stringMatching(/^[0-9a-f]{16}$/);

function frame(
	type: ClientFrame["type"],
	body: object = {},
	slot = 0,
	doc = DOC,
): ClientFrame {
	return { type, slot, doc, ...body } as ClientFrame;
}

function sub(core: HubCore, who: FakePeer, since = 0, slot = 0): ServerFrame {
	send(core, who, frame(EFrame.Sub, { since }, slot));
	return who.inbox.pop() as ServerFrame;
}

function update(
	core: HubCore,
	who: FakePeer,
	byte: number,
	slot = 0,
	doc = DOC,
): void {
	send(
		core,
		who,
		frame(EFrame.Update, { payload: Uint8Array.of(byte) }, slot, doc),
	);
}

function rotate(
	target: string,
	upto: number,
	byte: number,
	note = new Uint8Array(),
): ClientFrame {
	return frame(EFrame.Rotate, {
		target,
		upto,
		note,
		payload: Uint8Array.of(byte),
	});
}

/** A hub over storage that outlives it, as a Durable Object's does across restarts. */
function over(sql: Sql, ...peers: FakePeer[]): HubCore {
	return new HubCore(() => peers, new SqlDocStore(sql));
}

function logOf(state: ServerFrame): string {
	return (state as { log?: string }).log ?? "";
}

function refused(at: string, reason: number, slot = 0): ServerFrame {
	return { type: EFrame.Refused, slot, doc: at, reason } as ServerFrame;
}

describe("hub documents", () => {
	it("answers a subscription with the document's state", () => {
		const device = peer(1, [grant(VAULT)]);
		const core = hub(device);

		expect(sub(core, device)).toEqual({
			type: EFrame.State,
			slot: 0,
			doc: DOC,
			head: 0,
			snapshot: null,
			deltas: [],
			log: "",
		});
		expect(device.subs).toEqual([[0, DOC]]);
	});

	it("names each log, and a log lost and grown again differently", () => {
		const device = peer(1, [grant(VAULT)]);
		const sql = memorySql();
		const before = over(sql, device);
		sub(before, device);
		update(before, device, 1);
		update(before, device, 2);
		const named = sub(before, device);

		const after = hub(device);
		sub(after, device);
		update(after, device, 3);
		const regrown = sub(after, device);

		expect(named).toMatchObject({ head: 2, log: LOG });
		expect(regrown).toMatchObject({ head: 1, log: LOG });
		expect(logOf(regrown)).not.toBe(logOf(named));
		expect(sub(over(sql, device), device)).toEqual(named);
	});

	it("acks an update to its sender and fans it out to the document's followers only", () => {
		const sender = peer(1, [grant(VAULT)]);
		const follower = peer(2, [grant(OTHER), grant(VAULT)]);
		const bystander = peer(3, [grant(VAULT)]);
		const core = hub(sender, follower, bystander);
		sub(core, sender);
		sub(core, follower, 0, 1);
		follower.inbox.length = 0;
		sender.inbox.length = 0;

		update(core, sender, 7);

		expect(sender.inbox).toEqual([
			{ type: EFrame.Echo, slot: 0, doc: DOC, seq: 1 },
		]);
		expect(follower.inbox).toEqual([
			{
				type: EFrame.Fanout,
				slot: 1,
				doc: DOC,
				seq: 1,
				from: 1,
				payload: Uint8Array.of(7),
			},
		]);
		expect(bystander.inbox).toEqual([]);
	});

	it("keeps no update from a socket that does not follow the document", () => {
		const stranger = peer(1, [grant(VAULT)]);
		const reader = peer(2, [grant(VAULT)]);
		const core = hub(stranger, reader);

		update(core, stranger, 1);

		expect(stranger.inbox).toEqual([]);
		expect(sub(core, reader)).toMatchObject({ head: 0, deltas: [] });
	});

	it("lets a read-only participant follow a document but never write it", () => {
		const viewer = peer(1, [grant(VAULT, "viewer", "p2", true)]);
		const reader = peer(2, [grant(VAULT)]);
		const core = hub(viewer, reader);
		sub(core, viewer);
		viewer.inbox.length = 0;

		update(core, viewer, 1);
		send(core, viewer, frame(EFrame.Seed, { payload: Uint8Array.of(2) }));
		send(core, viewer, rotate(NEXT, 0, 3));

		expect(viewer.inbox).toEqual(
			Array.from({ length: 3 }, () => refused(DOC, ERefusal.ReadOnly)),
		);
		expect(sub(core, reader)).toMatchObject({ head: 0, deltas: [] });
	});

	it("takes the first seed of a document and answers a later one with the room", () => {
		const first = peer(1, [grant(VAULT)]);
		const second = peer(2, [grant(VAULT)]);
		const core = hub(first, second);
		sub(core, first);
		sub(core, second);
		first.inbox.length = 0;

		send(core, first, frame(EFrame.Seed, { payload: Uint8Array.of(1) }));
		send(core, second, frame(EFrame.Seed, { payload: Uint8Array.of(2) }));

		expect(first.inbox).toEqual([
			{ type: EFrame.Echo, slot: 0, doc: DOC, seq: 1 },
		]);
		expect(second.inbox).toEqual([
			expect.objectContaining({ type: EFrame.Fanout, seq: 1 }),
			expect.objectContaining({
				type: EFrame.State,
				head: 1,
				deltas: [Uint8Array.of(1)],
			}),
		]);
	});

	it("refuses a seed once the log was compacted away", () => {
		const device = peer(1, [grant(VAULT)]);
		const core = hub(device);
		sub(core, device);
		update(core, device, 1);
		send(
			core,
			device,
			frame(EFrame.Snapshot, { upto: 1, payload: Uint8Array.of(9) }),
		);
		device.inbox.length = 0;

		send(core, device, frame(EFrame.Seed, { payload: Uint8Array.of(2) }));

		expect(device.inbox).toEqual([
			expect.objectContaining({
				type: EFrame.State,
				head: 1,
				snapshot: Uint8Array.of(9),
				deltas: [],
			}),
		]);
	});

	it("sends a returning follower only what it has not seen", () => {
		const device = peer(1, [grant(VAULT)]);
		const core = hub(device);
		sub(core, device);
		for (const byte of [1, 2, 3]) update(core, device, byte);

		const returning = peer(2, [grant(VAULT)]);
		const again = hub(device, returning);
		expect(sub(again, returning, 1)).toMatchObject({ head: 0 });
		expect(sub(core, device, 1)).toMatchObject({
			head: 3,
			snapshot: null,
			deltas: [Uint8Array.of(2), Uint8Array.of(3)],
		});
	});

	it("introduces a newcomer to followers once, so they re-announce", () => {
		const follower = peer(1, [grant(VAULT)]);
		const newcomer = peer(2, [grant(VAULT, "t", "participant-1")]);
		const bystander = peer(3, [grant(VAULT)]);
		const core = hub(follower, newcomer, bystander);
		sub(core, follower);

		sub(core, newcomer);
		sub(core, newcomer);

		expect(follower.inbox).toEqual([
			{
				type: EFrame.Join,
				slot: 0,
				doc: DOC,
				from: 2,
				who: "participant-1",
				name: "",
			},
		]);
		expect(bystander.inbox).toEqual([]);
		expect(newcomer.subs).toHaveLength(1);
	});

	it("forwards document awareness to other followers", () => {
		const sender = peer(1, [grant(VAULT)]);
		const follower = peer(2, [grant(VAULT)]);
		const core = hub(sender, follower);
		sub(core, sender);
		sub(core, follower);
		sender.inbox.length = 0;

		send(core, sender, frame(EFrame.Awareness, { payload: Uint8Array.of(9) }));

		expect(follower.inbox).toEqual([
			{
				type: EFrame.Peer,
				slot: 0,
				doc: DOC,
				from: 1,
				payload: Uint8Array.of(9),
			},
		]);
		expect(sender.inbox).toEqual([]);
	});

	it("announces an unsubscribe and stops taking updates after it", () => {
		const leaving = peer(1, [grant(VAULT)]);
		const follower = peer(2, [grant(VAULT)]);
		const core = hub(leaving, follower);
		sub(core, leaving);
		sub(core, follower);
		leaving.inbox.length = 0;

		send(core, leaving, frame(EFrame.Unsub));
		update(core, leaving, 1);

		expect(follower.inbox).toEqual([
			{ type: EFrame.Leave, slot: 0, doc: DOC, from: 1 },
		]);
		expect(leaving.inbox).toEqual([]);
		expect(leaving.subs).toEqual([]);
	});

	it("replaces covered deltas with a snapshot and refuses stale or empty ones", () => {
		const device = peer(1, [grant(VAULT)]);
		const core = hub(device);
		sub(core, device);
		for (const byte of [1, 2, 3]) update(core, device, byte);
		const snapshot = (upto: number, payload: Uint8Array) =>
			send(core, device, frame(EFrame.Snapshot, { upto, payload }));

		snapshot(2, Uint8Array.of(12));
		snapshot(1, Uint8Array.of(11));
		snapshot(9, new Uint8Array());

		expect(sub(core, device)).toMatchObject({
			head: 3,
			snapshot: Uint8Array.of(12),
			deltas: [Uint8Array.of(3)],
		});
		expect(sub(core, device, 2)).toMatchObject({
			snapshot: null,
			deltas: [Uint8Array.of(3)],
		});

		// A claim past the head covers only what exists.
		snapshot(99, Uint8Array.of(13));
		update(core, device, 4);
		expect(sub(core, device)).toMatchObject({
			head: 4,
			snapshot: Uint8Array.of(13),
			deltas: [Uint8Array.of(4)],
		});
	});

	it("seeds the successor and points everyone there, the rotator included", () => {
		const rotator = peer(1, [grant(VAULT)]);
		const follower = peer(2, [grant(VAULT)]);
		const late = peer(3, [grant(VAULT)]);
		const core = hub(rotator, follower, late);
		sub(core, rotator);
		sub(core, follower);
		update(core, rotator, 1);
		rotator.inbox.length = 0;
		follower.inbox.length = 0;

		send(core, rotator, rotate(NEXT, 1, 9));
		send(core, follower, rotate("c".repeat(32), 1, 8));
		update(core, follower, 2);

		const moved = {
			type: EFrame.Moved,
			slot: 0,
			doc: DOC,
			target: NEXT,
			note: new Uint8Array(),
		};
		expect(rotator.inbox).toEqual([moved]);
		expect(follower.inbox).toEqual([moved, moved, moved]);
		expect(sub(core, late)).toEqual(moved);
		expect(late.subs).toEqual([]);
		send(core, late, frame(EFrame.Sub, { since: 0 }, 0, NEXT));
		expect(late.inbox.pop()).toMatchObject({
			head: 1,
			deltas: [Uint8Array.of(9)],
		});
	});

	it("refuses a rotation the log has moved past and sends the rotator what it missed", () => {
		const rotator = peer(1, [grant(VAULT)]);
		const typist = peer(2, [grant(VAULT)]);
		const core = hub(rotator, typist);
		sub(core, rotator);
		sub(core, typist);
		update(core, rotator, 1);
		update(core, typist, 2);
		rotator.inbox.length = 0;
		typist.inbox.length = 0;

		send(core, rotator, rotate(NEXT, 1, 9));

		expect(rotator.inbox).toEqual([
			expect.objectContaining({
				type: EFrame.State,
				head: 2,
				deltas: [Uint8Array.of(2)],
			}),
		]);
		expect(typist.inbox).toEqual([]);
		send(core, typist, frame(EFrame.Sub, { since: 0 }, 0, NEXT));
		expect(typist.inbox.pop()).toMatchObject({ head: 0 });
	});

	it("never rotates into a document that already has a log", () => {
		const device = peer(1, [grant(VAULT)]);
		const core = hub(device);
		sub(core, device);
		update(core, device, 1);
		send(core, device, frame(EFrame.Sub, { since: 0 }, 0, NEXT));
		update(core, device, 5, 0, NEXT);
		device.inbox.length = 0;

		send(core, device, rotate(NEXT, 1, 9));

		expect(types(device)).toEqual([EFrame.State]);
		expect(sub(core, device).type).toBe(EFrame.State);
	});

	it("moves a document that lost its log on from its empty state", () => {
		const device = peer(1, [grant(VAULT)]);
		const core = hub(device);
		sub(core, device);

		send(core, device, rotate(NEXT, 0, 9));

		expect(device.inbox).toEqual([
			{
				type: EFrame.Moved,
				slot: 0,
				doc: DOC,
				target: NEXT,
				note: new Uint8Array(),
			},
		]);
		send(core, device, frame(EFrame.Sub, { since: 0 }, 0, NEXT));
		expect(device.inbox.pop()).toMatchObject({
			head: 1,
			deltas: [Uint8Array.of(9)],
		});
	});

	it("hands the mover's note to every follower and to anyone who asks later", () => {
		const mover = peer(1, [grant(VAULT)]);
		const follower = peer(2, [grant(VAULT)]);
		const late = peer(3, [grant(VAULT)]);
		const core = hub(mover, follower, late);
		sub(core, mover);
		sub(core, follower);
		update(core, mover, 1);
		follower.inbox.length = 0;

		send(core, mover, rotate(NEXT, 1, 9, Uint8Array.of(4, 2)));

		const moved = {
			type: EFrame.Moved,
			target: NEXT,
			note: Uint8Array.of(4, 2),
		};
		expect(follower.inbox).toEqual([expect.objectContaining(moved)]);
		expect(sub(core, late)).toMatchObject(moved);
	});

	it("ignores a rotation that does not name another document, or with an oversized note", () => {
		const device = peer(1, [grant(VAULT)]);
		const core = hub(device);
		sub(core, device);
		update(core, device, 1);

		send(core, device, rotate(DOC, 1, 9));
		send(core, device, rotate("", 1, 9));
		send(
			core,
			device,
			rotate(NEXT, 1, 9, new Uint8Array(MAX_MOVE_NOTE_BYTES + 1)),
		);

		expect(sub(core, device).type).toBe(EFrame.State);
	});

	it("tells followers when a socket closes or loses the channel", () => {
		const closing = peer(1, [grant(VAULT)]);
		const revoked = peer(2, [grant(OTHER), grant(VAULT, "p-token")]);
		const follower = peer(3, [grant(VAULT)]);
		const core = hub(closing, revoked, follower);
		sub(core, closing);
		sub(core, revoked, 0, 1);
		sub(core, follower);
		follower.inbox.length = 0;

		core.leave(closing);
		core.dropGrant("p-token");

		const docLeaves = follower.inbox.filter((f) => f.doc === DOC);
		expect(docLeaves).toEqual([
			{ type: EFrame.Leave, slot: 0, doc: DOC, from: 1 },
			{ type: EFrame.Leave, slot: 0, doc: DOC, from: 2 },
		]);
		expect(revoked.subs).toEqual([]);
	});

	it("caps the documents one socket may follow", () => {
		const device = peer(1, [grant(VAULT)]);
		const core = hub(device);
		for (let at = 0; at < MAX_DOC_SUBS; at++) {
			send(core, device, frame(EFrame.Sub, { since: 0 }, 0, `doc-${at}`));
		}
		device.inbox.length = 0;

		send(core, device, frame(EFrame.Sub, { since: 0 }, 0, "one-too-many"));
		send(core, device, frame(EFrame.Sub, { since: 0 }, 0, "x".repeat(65)));

		expect(device.inbox).toEqual([
			refused("one-too-many", ERefusal.TooManyDocs),
		]);
		expect(device.subs).toHaveLength(MAX_DOC_SUBS);
	});

	it("keeps each channel's documents apart", () => {
		const device = peer(1, [grant(VAULT), grant(OTHER)]);
		const core = hub(device);
		sub(core, device);
		sub(core, device, 0, 1);
		update(core, device, 1);

		expect(sub(core, device, 0, 1)).toMatchObject({ head: 0, deltas: [] });
	});
});
