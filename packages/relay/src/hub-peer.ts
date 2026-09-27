/**
 * A hub socket as the pure hub logic sees it. One socket carries several
 * channels; a slot is that socket's index for a channel, so one channel can sit
 * at different slots on different sockets.
 */

import {
	type ClientFrame,
	encodeServer,
	type ServerFrame,
	withSlot,
} from "@obsync/protocol";

/** A channel a socket was admitted to, checked by the worker before the hub woke. */
export interface Grant {
	channel: string;
	/** Fingerprint of the admitting token, so revocation can find it. */
	grant: string;
	/** Who holds the token: a share participant, or the deployment owner. */
	who: string;
	/** A read-only participant follows documents but never writes them. */
	readOnly?: true;
}

/** A document a socket follows, addressed by the socket's own slot. */
export type DocSub = readonly [slot: number, doc: string];

export interface HubPeer {
	readonly tag: number;
	/** Opaque device id, so an HTTP signal can skip its own sender. */
	readonly device: string;
	/** Indexed by slot; null once revoked or refused at admission. */
	readonly slots: readonly (Grant | null)[];
	readonly subs: readonly DocSub[];
	send(bytes: Uint8Array): void;
	/** Persists the slot as revoked, with its subscriptions; other channels stay. */
	revoke(slot: number): void;
	subscribe(slot: number, doc: string): void;
	unsubscribe(slot: number, doc: string): void;
	close(code: number, reason: string): void;
}

export type Peers = () => Iterable<HubPeer>;

export interface HandlerContext {
	peers: Peers;
	peer: HubPeer;
	grant: Grant;
}

export type Handler<F> = (context: HandlerContext, frame: F) => void;

export type Handlers = {
	[K in ClientFrame["type"]]?: Handler<Extract<ClientFrame, { type: K }>>;
};

export function slotOf(peer: HubPeer, channel: string): number {
	return peer.slots.findIndex((grant) => grant?.channel === channel);
}

export function follows(peer: HubPeer, slot: number, doc: string): boolean {
	return peer.subs.some(([at, followed]) => at === slot && followed === doc);
}

/** Encodes once and readdresses per recipient; `accept` picks who gets it. */
export function broadcast(
	peers: Peers,
	channel: string,
	frame: ServerFrame,
	accept: (peer: HubPeer, slot: number) => boolean,
): void {
	const bytes = encodeServer(frame);
	for (const peer of peers()) {
		const slot = slotOf(peer, channel);
		if (slot >= 0 && accept(peer, slot)) peer.send(withSlot(bytes, slot));
	}
}
