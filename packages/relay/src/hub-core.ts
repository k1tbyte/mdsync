/**
 * Hub logic with no Durable Object in sight, so tests drive it with plain
 * objects. Channel-level frames (presence, the cold-sync signal) live here;
 * document frames go to `hub-docs`.
 */

import {
	CHANNEL_DOC,
	type ClientFrame,
	decodeClient,
	EFrame,
	ERefusal,
	encodeServer,
	MAX_FRAME_BYTES,
	UNAUTHORIZED_CLOSE_CODE,
} from "@obsync/protocol";
import { type DocStore, docHandlers, leaveDocs, refuse } from "./hub-docs";
import {
	addressed,
	joinFrame,
	leaveFrame,
	peerFrame,
	revokedFrame,
	type ServerBody,
	signalFrame,
} from "./hub-frames";
import {
	broadcast,
	type Grant,
	type Handler,
	type Handlers,
	type HubPeer,
	type Peers,
	resolved,
} from "./hub-peer";

/** Sender tag of a signal posted over HTTP, which no socket sent. */
export const RELAY_TAG = 0;

const CHANNEL_HANDLERS: Handlers = {
	[EFrame.Signal]: ({ peers, peer, grant }) =>
		toChannel(peers, grant.channel, signalFrame(peer.tag), peer.tag),
	[EFrame.Awareness]: ({ peers, peer, grant }, frame) =>
		toChannel(
			peers,
			grant.channel,
			peerFrame(peer.tag, frame.payload),
			peer.tag,
		),
};

export class HubCore {
	private readonly docs: Handlers;

	constructor(
		private readonly peers: Peers,
		private readonly store: DocStore,
	) {
		this.docs = docHandlers(store);
	}

	join(peer: HubPeer): void {
		peer.slots.forEach((grant, slot) => {
			if (!grant) {
				peer.send(encodeServer(revokedFrame(slot)));
				return;
			}
			toChannel(
				this.peers,
				grant.channel,
				joinFrame(peer.tag, grant.who),
				peer.tag,
			);
		});
	}

	handle(peer: HubPeer, bytes: Uint8Array): void {
		const frame = decodeClient(bytes);
		if (!frame) return;
		const grant = peer.slots[frame.slot];
		if (!grant) return;
		if (bytes.length > MAX_FRAME_BYTES) {
			if (frame.doc !== CHANNEL_DOC) refuse(peer, frame, ERefusal.TooLarge);
			return;
		}
		const handlers = frame.doc === CHANNEL_DOC ? CHANNEL_HANDLERS : this.docs;
		const handler = handlers[frame.type] as Handler<ClientFrame> | undefined;
		handler?.({ peers: this.peers, peer, grant }, frame);
	}

	leave(peer: HubPeer): void {
		const peers = resolved(this.peers);
		leaveDocs(peers, peer);
		for (const grant of peer.slots) {
			if (grant) {
				toChannel(peers, grant.channel, leaveFrame(peer.tag), peer.tag);
			}
		}
	}

	/** The cold-sync ping for a device whose socket is down. */
	signal(channel: string, exceptDevice: string): void {
		broadcast(
			this.peers,
			channel,
			addressed(signalFrame(RELAY_TAG)),
			(peer) => !exceptDevice || peer.device !== exceptDevice,
		);
	}

	/** Cuts one token everywhere it was admitted, leaving the sockets' other channels alone. */
	dropGrant(fingerprint: string): void {
		this.drop((grant) => grant.grant === fingerprint);
	}

	/** Cuts every grant of a channel and deletes its documents: nothing can write it back. */
	closeChannel(channel: string): void {
		this.drop((grant) => grant.channel === channel);
		this.store.purge(channel);
	}

	private drop(matches: (grant: Grant) => boolean): void {
		const peers = resolved(this.peers);
		for (const peer of peers()) {
			let dropped = false;
			peer.slots.forEach((grant, slot) => {
				if (!grant || !matches(grant)) return;
				leaveDocs(peers, peer, slot);
				peer.revoke(slot);
				peer.send(encodeServer(revokedFrame(slot)));
				toChannel(peers, grant.channel, leaveFrame(peer.tag), peer.tag);
				dropped = true;
			});
			if (dropped && peer.slots.every((grant) => grant === null)) {
				peer.close(UNAUTHORIZED_CLOSE_CODE, "Unauthorized");
			}
		}
	}
}

function toChannel(
	peers: Peers,
	channel: string,
	body: ServerBody,
	exceptTag: number,
): void {
	broadcast(peers, channel, addressed(body), (peer) => peer.tag !== exceptTag);
}
