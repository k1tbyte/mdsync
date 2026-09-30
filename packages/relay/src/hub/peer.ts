/**
 * A hub socket as the pure hub logic sees it. One socket carries several
 * channels; a slot is that socket's index for a channel, so one channel can sit
 * at different slots on different sockets.
 */

/** A channel a socket was admitted to, checked by the worker before the hub woke. */
export interface Grant {
	channel: string;
	/** Fingerprint of the admitting token, so revocation can find it. */
	grant: string;
	/** A share participant's id, or the deployment owner. */
	who: string;
	readOnly?: true;
	/** The name the owner invited a participant by: others see this, not what they call themselves. */
	name?: string;
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

export function slotOf(peer: HubPeer, channel: string): number {
	return peer.slots.findIndex((grant) => grant?.channel === channel);
}

export function grantOn(peer: HubPeer, channel: string): Grant | undefined {
	return peer.slots.find((grant) => grant?.channel === channel) ?? undefined;
}

export function follows(peer: HubPeer, slot: number, doc: string): boolean {
	return peer.subs.some(([at, followed]) => at === slot && followed === doc);
}
