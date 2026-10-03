/** Server frames the hub builds itself, and their delivery. */

import {
	type Address,
	CHANNEL_DOC,
	EFrame,
	encodeServer,
	type Refusal,
	type ServerFrame,
	withSlot,
} from "@mdsync/protocol";

import { follows, type Grant, type HubPeer, slotOf } from "./peer";

type Unaddressed<F> = F extends ServerFrame ? Omit<F, "slot" | "doc"> : never;
export type ServerBody = Unaddressed<ServerFrame>;

export const signalFrame = (from: number): ServerBody => ({
	type: EFrame.Signal,
	from,
});

export const leaveFrame = (from: number): ServerBody => ({
	type: EFrame.Leave,
	from,
});

export const peerFrame = (from: number, payload: Uint8Array): ServerBody => ({
	type: EFrame.Peer,
	from,
	payload,
});

export const movedFrame = (pointer: {
	target: string;
	note: Uint8Array;
}): ServerBody => ({ type: EFrame.Moved, ...pointer });

export function vouchedFrame(
	type: typeof EFrame.Join | typeof EFrame.Here,
	from: number,
	grant: Grant,
): ServerBody {
	return { type, from, who: grant.who, name: grant.name ?? "" };
}

export function send(
	peer: HubPeer,
	slot: number,
	doc: string,
	body: ServerBody,
): void {
	peer.send(encodeServer({ ...body, slot, doc }));
}

/** Unanswered, a dropped frame looks like a slow one: the client would wait forever. */
export function refuse(
	peer: HubPeer,
	{ slot, doc }: Address,
	reason: Refusal,
): void {
	send(peer, slot, doc, { type: EFrame.Refused, reason });
}

/** Encodes once and readdresses per recipient; `accept` picks who gets it. */
export function broadcast(
	peers: readonly HubPeer[],
	channel: string,
	doc: string,
	body: ServerBody,
	accept: (peer: HubPeer, slot: number) => boolean,
): void {
	const bytes = encodeServer({ ...body, slot: 0, doc });
	for (const peer of peers) {
		const slot = slotOf(peer, channel);
		if (slot >= 0 && accept(peer, slot)) peer.send(withSlot(bytes, slot));
	}
}

export function toChannel(
	peers: readonly HubPeer[],
	channel: string,
	body: ServerBody,
	exceptTag: number,
): void {
	broadcast(
		peers,
		channel,
		CHANNEL_DOC,
		body,
		(peer) => peer.tag !== exceptTag,
	);
}

export function toFollowers(
	peers: readonly HubPeer[],
	channel: string,
	doc: string,
	body: ServerBody,
	exceptTag: number,
): void {
	broadcast(
		peers,
		channel,
		doc,
		body,
		(peer, slot) => peer.tag !== exceptTag && follows(peer, slot, doc),
	);
}
