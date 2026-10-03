/** Hub logic with no Durable Object, so tests drive it with plain objects; document frames go to `Documents`. */

import {
	CHANNEL_DOC,
	type ClientFrame,
	decodeClient,
	EFrame,
	ERefusal,
	MAX_FRAME_BYTES,
	UNAUTHORIZED_CLOSE_CODE,
} from "@mdsync/protocol";
import { type DocStore, Documents, type FrameContext, leaveDocs } from "./docs";
import {
	broadcast,
	leaveFrame,
	peerFrame,
	refuse,
	send,
	signalFrame,
	toChannel,
	vouchedFrame,
} from "./frames";
import { FrameLimits } from "./limits";
import { type Grant, grantOn, type HubPeer } from "./peer";

/** Sender tag of a signal posted over HTTP, which no socket sent. */
export const RELAY_TAG = 0;

export class HubCore {
	private readonly documents: Documents;
	private readonly limits = new FrameLimits();

	constructor(
		private readonly peers: () => readonly HubPeer[],
		private readonly store: DocStore,
	) {
		this.documents = new Documents(store);
	}

	join(peer: HubPeer): void {
		const peers = this.peers();
		peer.slots.forEach((grant, slot) => {
			if (!grant) {
				send(peer, slot, CHANNEL_DOC, { type: EFrame.Revoked });
				return;
			}
			// Before any announcement: the newcomer shows only people the hub vouches for.
			for (const other of peers) {
				const theirs =
					other.tag === peer.tag ? undefined : grantOn(other, grant.channel);
				if (!theirs) continue;
				const here = vouchedFrame(EFrame.Here, other.tag, theirs);
				send(peer, slot, CHANNEL_DOC, here);
			}
			const join = vouchedFrame(EFrame.Join, peer.tag, grant);
			toChannel(peers, grant.channel, join, peer.tag);
		});
	}

	handle(peer: HubPeer, bytes: Uint8Array): void {
		const frame = decodeClient(bytes);
		if (!frame) return;
		const grant = peer.slots[frame.slot];
		if (!grant) return;
		const readOnly = grant.readOnly === true;
		if (!this.limits.allows(peer.tag, frame, readOnly, bytes.length)) return;
		if (bytes.length > MAX_FRAME_BYTES) {
			if (frame.doc !== CHANNEL_DOC) refuse(peer, frame, ERefusal.TooLarge);
			return;
		}
		const context = { peers: this.peers(), peer, grant };
		if (frame.doc === CHANNEL_DOC) this.handleChannel(context, frame);
		else this.documents.handle(context, frame);
	}

	leave(peer: HubPeer): void {
		this.limits.forget(peer.tag);
		const peers = this.peers();
		leaveDocs(peers, peer);
		for (const grant of peer.slots) {
			if (grant)
				toChannel(peers, grant.channel, leaveFrame(peer.tag), peer.tag);
		}
	}

	/** The cold-sync ping for a device whose socket is down. */
	signal(channel: string, exceptDevice: string): void {
		broadcast(
			this.peers(),
			channel,
			CHANNEL_DOC,
			signalFrame(RELAY_TAG),
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

	private handleChannel(
		{ peers, peer, grant }: FrameContext,
		frame: ClientFrame,
	): void {
		if (frame.type === EFrame.Signal) {
			toChannel(peers, grant.channel, signalFrame(peer.tag), peer.tag);
		} else if (frame.type === EFrame.Awareness) {
			const body = peerFrame(peer.tag, frame.payload);
			toChannel(peers, grant.channel, body, peer.tag);
		}
	}

	private drop(matches: (grant: Grant) => boolean): void {
		const peers = this.peers();
		for (const peer of peers) {
			let dropped = false;
			peer.slots.forEach((grant, slot) => {
				if (!grant || !matches(grant)) return;
				leaveDocs(peers, peer, slot);
				peer.revoke(slot);
				send(peer, slot, CHANNEL_DOC, { type: EFrame.Revoked });
				toChannel(peers, grant.channel, leaveFrame(peer.tag), peer.tag);
				dropped = true;
			});
			if (dropped && peer.slots.every((grant) => grant === null)) {
				peer.close(UNAUTHORIZED_CLOSE_CODE, "Unauthorized");
			}
		}
	}
}
