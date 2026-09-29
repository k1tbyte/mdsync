import {
	CHANNEL_DOC,
	EFrame,
	ERefusal,
	MAX_FRAME_BYTES,
	UNAUTHORIZED_CLOSE_CODE,
} from "@obsync/protocol";
import { describe, expect, it } from "vitest";

import { HubCore, RELAY_TAG } from "../src/hub-core";
import { SqlDocStore } from "../src/hub-store";
import { grant, hub, peer, send, types } from "./helpers/hub";
import { memorySql } from "./helpers/memory-sql";

const VAULT = "vault-channel";
const SHARE = "obsync-share-s1";
const DOC = "d".repeat(32);

describe("hub", () => {
	it("announces a newcomer on each of its channels at the receiver's own slot", () => {
		const owner = peer(1, [grant(VAULT), grant(SHARE)]);
		const participant = peer(2, [grant(SHARE, "p-token", "participant-1")]);
		const core = hub(owner, participant);

		core.join(owner);

		expect(participant.inbox).toEqual([
			{ type: EFrame.Join, slot: 0, doc: CHANNEL_DOC, from: 1, who: "owner" },
		]);
		expect(owner.inbox).toEqual([]);
	});

	it("tells a socket at once which of its grants were refused", () => {
		const newcomer = peer(1, [grant(VAULT), null]);

		hub(newcomer).join(newcomer);

		expect(newcomer.inbox).toEqual([
			{ type: EFrame.Revoked, slot: 1, doc: CHANNEL_DOC },
		]);
	});

	it("relays a signal to the channel only, never back to its sender", () => {
		const sender = peer(1, [grant(VAULT), grant(SHARE)]);
		const vaultOnly = peer(2, [grant(VAULT)]);
		const shareOnly = peer(3, [grant(SHARE)]);
		const core = hub(sender, vaultOnly, shareOnly);

		send(core, sender, { type: EFrame.Signal, slot: 0, doc: CHANNEL_DOC });

		expect(vaultOnly.inbox).toEqual([
			{ type: EFrame.Signal, slot: 0, doc: CHANNEL_DOC, from: 1 },
		]);
		expect(shareOnly.inbox).toEqual([]);
		expect(sender.inbox).toEqual([]);
	});

	it("fans presence out with the sender's tag", () => {
		const sender = peer(1, [grant(SHARE)]);
		const other = peer(2, [grant(VAULT), grant(SHARE)]);
		const core = hub(sender, other);
		const payload = Uint8Array.of(1, 2);

		send(core, sender, {
			type: EFrame.Awareness,
			slot: 0,
			doc: CHANNEL_DOC,
			payload,
		});

		expect(other.inbox).toEqual([
			{ type: EFrame.Peer, slot: 1, doc: CHANNEL_DOC, from: 1, payload },
		]);
	});

	it("ignores frames on a slot the socket does not hold", () => {
		const sender = peer(1, [null, grant(VAULT)]);
		const other = peer(2, [grant(VAULT)]);
		const core = hub(sender, other);

		send(core, sender, { type: EFrame.Signal, slot: 0, doc: CHANNEL_DOC });
		send(core, sender, { type: EFrame.Signal, slot: 7, doc: CHANNEL_DOC });

		expect(other.inbox).toEqual([]);
	});

	it("ignores malformed and oversized frames", () => {
		const sender = peer(1, [grant(VAULT)]);
		const other = peer(2, [grant(VAULT)]);
		const core = hub(sender, other);

		core.handle(sender, Uint8Array.of(99));
		core.handle(sender, new Uint8Array(MAX_FRAME_BYTES + 1));

		expect(other.inbox).toEqual([]);
	});

	it("refuses a document frame past the cap to its sender, by document", () => {
		const sender = peer(1, [grant(VAULT)]);
		const other = peer(2, [grant(VAULT)]);
		const core = hub(sender, other);
		const payload = new Uint8Array(MAX_FRAME_BYTES);

		send(core, sender, { type: EFrame.Update, slot: 0, doc: "doc", payload });
		send(core, sender, {
			type: EFrame.Awareness,
			slot: 0,
			doc: CHANNEL_DOC,
			payload,
		});

		expect(sender.inbox).toEqual([
			{
				type: EFrame.Refused,
				slot: 0,
				doc: "doc",
				reason: ERefusal.TooLarge,
			},
		]);
		expect(other.inbox).toEqual([]);
	});

	it("announces a departure on every channel the socket held", () => {
		const leaving = peer(1, [grant(VAULT), grant(SHARE)]);
		const other = peer(2, [grant(SHARE), grant(VAULT)]);
		const core = hub(leaving, other);

		core.leave(leaving);

		expect(other.inbox).toEqual([
			{ type: EFrame.Leave, slot: 1, doc: CHANNEL_DOC, from: 1 },
			{ type: EFrame.Leave, slot: 0, doc: CHANNEL_DOC, from: 1 },
		]);
	});

	it("delivers an HTTP signal to the channel except the posting device", () => {
		const poster = peer(1, [grant(VAULT)], "laptop");
		const other = peer(2, [grant(VAULT)], "phone");
		const core = hub(poster, other);

		core.signal(VAULT, "laptop");

		expect(types(poster)).toEqual([]);
		expect(other.inbox).toEqual([
			{ type: EFrame.Signal, slot: 0, doc: CHANNEL_DOC, from: RELAY_TAG },
		]);
	});

	it("revokes one channel and keeps the socket's others", () => {
		const participant = peer(1, [grant(VAULT), grant(SHARE, "p-token")]);
		const owner = peer(2, [grant(SHARE)]);
		const core = hub(participant, owner);

		core.dropGrant("p-token");

		expect(participant.slots).toEqual([grant(VAULT), null]);
		expect(participant.inbox).toEqual([
			{ type: EFrame.Revoked, slot: 1, doc: CHANNEL_DOC },
		]);
		expect(participant.closed).toBeNull();
		expect(types(owner)).toEqual([EFrame.Leave]);

		send(core, participant, { type: EFrame.Signal, slot: 1, doc: CHANNEL_DOC });
		expect(types(owner)).toEqual([EFrame.Leave]);
	});

	it("closes a socket left with no channel", () => {
		const participant = peer(1, [grant(SHARE, "p-token")]);
		const bystander = peer(2, [grant(VAULT)]);

		hub(participant, bystander).dropGrant("p-token");

		expect(participant.closed).toBe(UNAUTHORIZED_CLOSE_CODE);
		expect(bystander.closed).toBeNull();
		expect(bystander.inbox).toEqual([]);
	});

	it("closes a channel everywhere, keeps the sockets' others and forgets its documents", () => {
		const owner = peer(1, [grant(VAULT), grant(SHARE)]);
		const guest = peer(2, [grant(SHARE, "g-token", "p1")]);
		const late = peer(3, [grant(SHARE)]);
		const core = hub(owner, guest, late);
		send(core, owner, { type: EFrame.Sub, slot: 1, doc: DOC, since: 0 });
		send(core, guest, { type: EFrame.Sub, slot: 0, doc: DOC, since: 0 });
		send(core, owner, {
			type: EFrame.Update,
			slot: 1,
			doc: DOC,
			payload: Uint8Array.of(1),
		});

		core.closeChannel(SHARE);

		expect(owner.slots).toEqual([grant(VAULT), null]);
		expect(owner.inbox).toContainEqual({
			type: EFrame.Revoked,
			slot: 1,
			doc: CHANNEL_DOC,
		});
		expect(owner.closed).toBeNull();
		expect(guest.slots).toEqual([null]);
		expect(guest.closed).toBe(UNAUTHORIZED_CLOSE_CODE);
		expect(late.closed).toBe(UNAUTHORIZED_CLOSE_CODE);

		const before = owner.inbox.length;
		send(core, owner, {
			type: EFrame.Update,
			slot: 1,
			doc: DOC,
			payload: Uint8Array.of(2),
		});
		expect(owner.inbox).toHaveLength(before);
	});

	it("deletes the closed channel's documents and no other's", () => {
		const first = peer(1, [grant(SHARE), grant(VAULT)]);
		const store = new SqlDocStore(memorySql());
		const core = new HubCore(() => [first], store);
		for (const slot of [0, 1]) {
			send(core, first, { type: EFrame.Sub, slot, doc: DOC, since: 0 });
			send(core, first, {
				type: EFrame.Update,
				slot,
				doc: DOC,
				payload: Uint8Array.of(1),
			});
		}

		core.closeChannel(SHARE);

		expect(store.state(SHARE, DOC, 0).head).toBe(0);
		expect(store.state(VAULT, DOC, 0).head).toBe(1);
	});

	it("looks the sockets up once when one leaves or is cut, whatever it followed", () => {
		const other = peer(2, [grant(VAULT, "cut")]);
		const leaving = peer(1, [grant(VAULT)]);
		let lookups = 0;
		const core = new HubCore(() => {
			lookups++;
			return [leaving, other];
		}, new SqlDocStore(memorySql()));
		for (const doc of ["a", "b", "c"]) {
			for (const who of [leaving, other]) {
				send(core, who, { type: EFrame.Sub, slot: 0, doc, since: 0 });
			}
		}
		other.inbox.length = 0;

		lookups = 0;
		core.leave(leaving);
		expect(lookups).toBe(1);
		expect(other.inbox).toHaveLength(4);

		lookups = 0;
		core.dropGrant("cut");
		expect(lookups).toBe(1);
	});
});
