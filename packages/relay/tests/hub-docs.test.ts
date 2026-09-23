import {
	type ClientFrame,
	EFrame,
	MAX_DOC_SUBS,
	type ServerFrame,
} from "@obsync/protocol";
import { describe, expect, it } from "vitest";

import type { HubCore } from "../src/hub-core";
import { type FakePeer, grant, hub, peer, send, types } from "./helpers/hub";

const VAULT = "vault-channel";
const OTHER = "other-channel";
const DOC = "a".repeat(32);
const NEXT = "b".repeat(32);

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

function update(core: HubCore, who: FakePeer, byte: number, slot = 0): void {
	send(core, who, frame(EFrame.Update, { payload: Uint8Array.of(byte) }, slot));
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
		});
		expect(device.subs).toEqual([[0, DOC]]);
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
			{ type: EFrame.Join, slot: 0, doc: DOC, from: 2, who: "participant-1" },
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

	it("moves a rotated document once and points everyone at its successor", () => {
		const rotator = peer(1, [grant(VAULT)]);
		const follower = peer(2, [grant(VAULT)]);
		const late = peer(3, [grant(VAULT)]);
		const core = hub(rotator, follower, late);
		sub(core, rotator);
		sub(core, follower);
		update(core, rotator, 1);
		rotator.inbox.length = 0;
		follower.inbox.length = 0;

		send(core, rotator, frame(EFrame.Rotate, { target: NEXT }));
		send(core, follower, frame(EFrame.Rotate, { target: "c".repeat(32) }));
		update(core, follower, 2);

		const moved = { type: EFrame.Moved, slot: 0, doc: DOC, target: NEXT };
		expect(rotator.inbox).toEqual([]);
		expect(follower.inbox).toEqual([moved, moved, moved]);
		expect(sub(core, late)).toEqual(moved);
		expect(late.subs).toEqual([]);
	});

	it("ignores a rotation that does not name another document", () => {
		const device = peer(1, [grant(VAULT)]);
		const core = hub(device);
		sub(core, device);

		send(core, device, frame(EFrame.Rotate, { target: DOC }));
		send(core, device, frame(EFrame.Rotate, { target: "" }));

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

		expect(types(device)).toEqual([]);
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
