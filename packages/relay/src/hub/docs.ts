/**
 * Live documents inside a channel. The hub never reads a document's encrypted
 * log: clients merge, it only orders updates, keeps what a client snapshot
 * covers and forwards the rest to the document's followers.
 */

import {
	type ClientFrame,
	EFrame,
	ERefusal,
	MAX_DOC_ID_LENGTH,
	MAX_DOC_SUBS,
	MAX_MOVE_NOTE_BYTES,
} from "@obsync/protocol";

import {
	broadcast,
	leaveFrame,
	movedFrame,
	peerFrame,
	refuse,
	send,
	toFollowers,
	vouchedFrame,
} from "./frames";
import { follows, type Grant, type HubPeer } from "./peer";

type Frame<T extends ClientFrame["type"]> = Extract<ClientFrame, { type: T }>;

export interface FrameContext {
	peers: readonly HubPeer[];
	peer: HubPeer;
	grant: Grant;
}

export interface DocState {
	head: number;
	snapshot: Uint8Array | null;
	deltas: Uint8Array[];
	/** Drawn when the log's first row is: a lost log grows again under another. */
	log: string;
}

/** Where a moved document continued, and the sealed note its mover left there. */
export interface Pointer {
	target: string;
	note: Uint8Array;
}

export interface DocStore {
	/** Null while the document is live. */
	movedTo(channel: string, doc: string): Pointer | null;
	/**
	 * Seeds the pointer's target and replaces this log with the pointer, only
	 * while the log ends at `upto` and the target has none; false changes nothing.
	 */
	rotate(
		channel: string,
		doc: string,
		pointer: Pointer,
		upto: number,
		payload: Uint8Array,
	): boolean;
	purge(channel: string): void;
	append(channel: string, doc: string, payload: Uint8Array): number;
	/** Appends only to a document with no log; null when it has one. */
	seed(channel: string, doc: string, payload: Uint8Array): number | null;
	/** The snapshot only when `since` predates it; deltas after both. */
	state(channel: string, doc: string, since: number): DocState;
	/** Replaces the deltas up to `upto` (clamped to the head) with the snapshot. Empty or older snapshots are refused: they would lose log. */
	compact(
		channel: string,
		doc: string,
		payload: Uint8Array,
		upto: number,
	): void;
}

export class Documents {
	constructor(private readonly store: DocStore) {}

	handle(context: FrameContext, frame: ClientFrame): void {
		if (frame.type === EFrame.Sub) this.subscribe(context, frame);
		else if (follows(context.peer, frame.slot, frame.doc)) {
			this.followed(context, frame);
		}
	}

	private followed(
		context: FrameContext,
		frame: Exclude<ClientFrame, Frame<typeof EFrame.Sub>>,
	): void {
		const { peers, peer, grant } = context;
		const { slot, doc } = frame;
		if (frame.type === EFrame.Unsub) {
			peer.unsubscribe(slot, doc);
			toFollowers(peers, grant.channel, doc, leaveFrame(peer.tag), peer.tag);
			return;
		}
		if (this.sendMoved(context, slot, doc)) return;
		if (frame.type === EFrame.Awareness) {
			const body = peerFrame(peer.tag, frame.payload);
			toFollowers(peers, grant.channel, doc, body, peer.tag);
			return;
		}
		if (grant.readOnly) {
			refuse(peer, frame, ERefusal.ReadOnly);
			return;
		}
		switch (frame.type) {
			case EFrame.Update:
				logged(
					context,
					frame,
					this.store.append(grant.channel, doc, frame.payload),
				);
				break;
			case EFrame.Seed:
				this.seed(context, frame);
				break;
			case EFrame.Snapshot:
				this.store.compact(grant.channel, doc, frame.payload, frame.upto);
				break;
			case EFrame.Rotate:
				this.rotate(context, frame);
				break;
		}
	}

	private subscribe(
		context: FrameContext,
		{ slot, doc, since }: Frame<typeof EFrame.Sub>,
	): void {
		const { peers, peer, grant } = context;
		if (doc.length > MAX_DOC_ID_LENGTH) return;
		if (this.sendMoved(context, slot, doc)) return;
		const fresh = !follows(peer, slot, doc);
		if (fresh && peer.subs.length >= MAX_DOC_SUBS) {
			refuse(peer, { slot, doc }, ERefusal.TooManyDocs);
			return;
		}
		if (fresh) peer.subscribe(slot, doc);
		this.sendState(peer, grant, slot, doc, since);
		if (!fresh) return;
		// Awareness is never stored: followers re-announce for the newcomer.
		const join = vouchedFrame(EFrame.Join, peer.tag, grant);
		toFollowers(peers, grant.channel, doc, join, peer.tag);
	}

	private seed(context: FrameContext, frame: Frame<typeof EFrame.Seed>): void {
		const { peer, grant } = context;
		const seq = this.store.seed(grant.channel, frame.doc, frame.payload);
		// Concurrent seeds would double the text: the loser gets the room to merge into.
		if (seq === null) this.sendState(peer, grant, frame.slot, frame.doc, 0);
		else logged(context, frame, seq);
	}

	private rotate(
		{ peers, peer, grant }: FrameContext,
		{ slot, doc, target, upto, note, payload }: Frame<typeof EFrame.Rotate>,
	): void {
		if (
			!target ||
			target === doc ||
			target.length > MAX_DOC_ID_LENGTH ||
			note.length > MAX_MOVE_NOTE_BYTES
		) {
			return;
		}
		const pointer = { target, note };
		// An update after `upto` would be acked here and missing there: the rotator gets the room instead.
		if (!this.store.rotate(grant.channel, doc, pointer, upto, payload)) {
			this.sendState(peer, grant, slot, doc, upto);
			return;
		}
		// The rotator follows too: this is its confirmation.
		broadcast(peers, grant.channel, doc, movedFrame(pointer), (at, atSlot) =>
			follows(at, atSlot, doc),
		);
	}

	/** A moved document answers with its pointer, whatever was asked. */
	private sendMoved(
		{ peer, grant }: FrameContext,
		slot: number,
		doc: string,
	): boolean {
		const pointer = this.store.movedTo(grant.channel, doc);
		if (pointer) send(peer, slot, doc, movedFrame(pointer));
		return pointer !== null;
	}

	private sendState(
		peer: HubPeer,
		grant: Grant,
		slot: number,
		doc: string,
		since: number,
	): void {
		const state = this.store.state(grant.channel, doc, since);
		send(peer, slot, doc, { type: EFrame.State, ...state });
	}
}

/** Tells the followers of each document the socket follows (on one slot, if given) that it left. */
export function leaveDocs(
	peers: readonly HubPeer[],
	peer: HubPeer,
	slot?: number,
): void {
	for (const [at, doc] of peer.subs) {
		const grant = peer.slots[at];
		if (!grant || (slot !== undefined && at !== slot)) continue;
		toFollowers(peers, grant.channel, doc, leaveFrame(peer.tag), peer.tag);
	}
}

/** The echo is the sender's ack, by its own counter: a frame dropped past the rate leaves a gap it can see. */
function logged(
	{ peers, peer, grant }: FrameContext,
	{
		slot,
		doc,
		n,
		payload,
	}: { slot: number; doc: string; n: number; payload: Uint8Array },
	seq: number,
): void {
	send(peer, slot, doc, { type: EFrame.Echo, seq, n });
	const fanout = { type: EFrame.Fanout, seq, from: peer.tag, payload } as const;
	toFollowers(peers, grant.channel, doc, fanout, peer.tag);
}
