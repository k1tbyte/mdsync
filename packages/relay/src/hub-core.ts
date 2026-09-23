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
	encodeServer,
	type ServerFrame,
	UNAUTHORIZED_CLOSE_CODE,
} from "@obsync/protocol";

import { type DocStore, docHandlers, leaveDocs } from "./hub-docs";
import {
	broadcast,
	type Handler,
	type Handlers,
	type HubPeer,
	type Peers,
} from "./hub-peer";

/** A blind hub cannot tell a large edit from abuse; it can only cap the frame. */
const MAX_FRAME_BYTES = 1024 * 1024;
/** Sender tag of a signal posted over HTTP, which no socket sent. */
export const RELAY_TAG = 0;

const CHANNEL_HANDLERS: Handlers = {
	[EFrame.Signal]: ({ peers, peer, grant }) =>
		toChannel(peers, grant.channel, signalFrame(peer.tag), peer.tag),
	[EFrame.Awareness]: ({ peers, peer, grant }, frame) =>
		toChannel(
			peers,
			grant.channel,
			{
				...channelAddress(),
				type: EFrame.Peer,
				from: peer.tag,
				payload: frame.payload,
			},
			peer.tag,
		),
};

export class HubCore {
	private readonly docs: Handlers;

	constructor(
		private readonly peers: Peers,
		store: DocStore,
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
		if (bytes.length > MAX_FRAME_BYTES) return;
		const frame = decodeClient(bytes);
		if (!frame) return;
		const grant = peer.slots[frame.slot];
		if (!grant) return;
		const handlers = frame.doc === CHANNEL_DOC ? CHANNEL_HANDLERS : this.docs;
		const handler = handlers[frame.type] as Handler<ClientFrame> | undefined;
		handler?.({ peers: this.peers, peer, grant }, frame);
	}

	leave(peer: HubPeer): void {
		leaveDocs(this.peers, peer);
		for (const grant of peer.slots) {
			if (grant) {
				toChannel(this.peers, grant.channel, leaveFrame(peer.tag), peer.tag);
			}
		}
	}

	/** The cold-sync ping for a device whose socket is down. */
	signal(channel: string, exceptDevice: string): void {
		broadcast(
			this.peers,
			channel,
			signalFrame(RELAY_TAG),
			(peer) => !exceptDevice || peer.device !== exceptDevice,
		);
	}

	/** Cuts one token everywhere it was admitted, leaving the sockets' other channels alone. */
	dropGrant(fingerprint: string): void {
		for (const peer of [...this.peers()]) {
			let dropped = false;
			peer.slots.forEach((grant, slot) => {
				if (grant?.grant !== fingerprint) return;
				leaveDocs(this.peers, peer, slot);
				peer.revoke(slot);
				peer.send(encodeServer(revokedFrame(slot)));
				toChannel(this.peers, grant.channel, leaveFrame(peer.tag), peer.tag);
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
	frame: ServerFrame,
	exceptTag: number,
): void {
	broadcast(peers, channel, frame, (peer) => peer.tag !== exceptTag);
}

function channelAddress(slot = 0) {
	return { slot, doc: CHANNEL_DOC };
}

function signalFrame(from: number): ServerFrame {
	return { ...channelAddress(), type: EFrame.Signal, from };
}

function joinFrame(from: number, who: string): ServerFrame {
	return { ...channelAddress(), type: EFrame.Join, from, who };
}

function leaveFrame(from: number): ServerFrame {
	return { ...channelAddress(), type: EFrame.Leave, from };
}

function revokedFrame(slot: number): ServerFrame {
	return { ...channelAddress(slot), type: EFrame.Revoked };
}
