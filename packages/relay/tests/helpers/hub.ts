import {
	type ClientFrame,
	decodeServer,
	encodeClient,
	type ServerFrame,
} from "@obsync/protocol";

import { HubCore } from "../../src/hub-core";
import type { DocSub, Grant, HubPeer } from "../../src/hub-peer";
import { SqlDocStore } from "../../src/hub-store";

import { memorySql } from "./memory-sql";

export interface FakePeer extends HubPeer {
	slots: (Grant | null)[];
	subs: DocSub[];
	inbox: ServerFrame[];
	closed: number | null;
}

export function grant(
	channel: string,
	token = `${channel}-token`,
	who = "owner",
	readOnly = false,
): Grant {
	return { channel, grant: token, who, ...(readOnly ? { readOnly } : {}) };
}

export function peer(
	tag: number,
	slots: (Grant | null)[],
	device = `device-${tag}`,
): FakePeer {
	const fake: FakePeer = {
		tag,
		device,
		slots,
		subs: [],
		inbox: [],
		closed: null,
		send(bytes) {
			const frame = decodeServer(bytes);
			if (frame) fake.inbox.push(frame);
		},
		revoke(slot) {
			fake.slots[slot] = null;
			fake.subs = fake.subs.filter(([at]) => at !== slot);
		},
		subscribe(slot, doc) {
			fake.subs.push([slot, doc]);
		},
		unsubscribe(slot, doc) {
			fake.subs = fake.subs.filter(
				([at, followed]) => at !== slot || followed !== doc,
			);
		},
		close(code) {
			fake.closed = code;
		},
	};
	return fake;
}

/** A hub over a fresh in-memory SQLite, the same store the Durable Object runs. */
export function hub(...peers: FakePeer[]): HubCore {
	return new HubCore(() => peers, new SqlDocStore(memorySql()));
}

export function send(core: HubCore, from: FakePeer, frame: ClientFrame): void {
	core.handle(from, encodeClient(frame));
}

export function types(target: FakePeer): number[] {
	return target.inbox.map((frame) => frame.type);
}
