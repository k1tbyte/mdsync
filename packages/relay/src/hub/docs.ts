/**
 * Live documents inside a channel. The hub keeps each document's encrypted log
 * and never reads it: clients merge, the hub only orders updates, keeps what a
 * client snapshot covers and forwards the rest to the document's followers.
 */

import {
	type ClientFrame,
	EFrame,
	ERefusal,
	encodeServer,
	MAX_DOC_ID_LENGTH,
	MAX_DOC_SUBS,
	MAX_MOVE_NOTE_BYTES,
	type Refusal,
} from "@obsync/protocol";

import {
	addressed,
	joinFrame,
	leaveFrame,
	movedFrame,
	peerFrame,
	refusedFrame,
	type ServerBody,
} from "./frames";
import {
	broadcast,
	follows,
	type Grant,
	type Handler,
	type HandlerContext,
	type Handlers,
	type HubPeer,
	type Peers,
} from "./peer";

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
	/** Deletes every document of the channel, pointers included. */
	purge(channel: string): void;
	append(channel: string, doc: string, payload: Uint8Array): number;
	/** Appends only to a document with no log; null when it has one. */
	seed(channel: string, doc: string, payload: Uint8Array): number | null;
	/** The snapshot only when `since` predates it; deltas after both. */
	state(channel: string, doc: string, since: number): DocState;
	/**
	 * Replaces the deltas up to `upto` (clamped to the head) with the snapshot.
	 * An empty snapshot would delete the log it claims to cover, and one older
	 * than the snapshot held is refused: what lay between them is gone.
	 */
	compact(
		channel: string,
		doc: string,
		payload: Uint8Array,
		upto: number,
	): void;
}

export function docHandlers(store: DocStore): Handlers {
	/** Frames that need a subscription; a moved document answers with its pointer. */
	const live =
		<F extends ClientFrame>(handler: Handler<F>): Handler<F> =>
		(context, frame) => {
			const { peer, grant } = context;
			if (!follows(peer, frame.slot, frame.doc)) return;
			const pointer = store.movedTo(grant.channel, frame.doc);
			if (pointer !== null) {
				peer.send(encodeServer(movedFrame(frame.slot, frame.doc, pointer)));
				return;
			}
			handler(context, frame);
		};
	/** Frames that change a document; a read-only grant only follows. */
	const write = <F extends ClientFrame>(handler: Handler<F>): Handler<F> =>
		live((context, frame) => {
			const { grant, peer } = context;
			if (!grant.readOnly) handler(context, frame);
			else refuse(peer, frame, ERefusal.ReadOnly);
		});
	const sendState = (
		peer: HubPeer,
		grant: Grant,
		slot: number,
		doc: string,
		since: number,
	) =>
		peer.send(
			encodeServer({
				type: EFrame.State,
				slot,
				doc,
				...store.state(grant.channel, doc, since),
			}),
		);

	return {
		[EFrame.Sub]: ({ peers, peer, grant }, { slot, doc, since }) => {
			if (doc.length > MAX_DOC_ID_LENGTH) return;
			const pointer = store.movedTo(grant.channel, doc);
			if (pointer !== null) {
				peer.send(encodeServer(movedFrame(slot, doc, pointer)));
				return;
			}
			const fresh = !follows(peer, slot, doc);
			if (fresh && peer.subs.length >= MAX_DOC_SUBS) {
				refuse(peer, { slot, doc }, ERefusal.TooManyDocs);
				return;
			}
			if (fresh) peer.subscribe(slot, doc);
			sendState(peer, grant, slot, doc, since);
			// Awareness is never stored, so followers re-announce for the newcomer.
			if (fresh) {
				toFollowers(
					peers,
					grant.channel,
					doc,
					peer,
					joinFrame(peer.tag, grant),
				);
			}
		},
		[EFrame.Unsub]: ({ peers, peer, grant }, { slot, doc }) => {
			if (!follows(peer, slot, doc)) return;
			peer.unsubscribe(slot, doc);
			toFollowers(peers, grant.channel, doc, peer, leaveFrame(peer.tag));
		},
		[EFrame.Update]: write((context, frame) =>
			logged(
				context,
				frame,
				store.append(context.grant.channel, frame.doc, frame.payload),
			),
		),
		[EFrame.Seed]: write((context, frame) => {
			const { peer, grant } = context;
			const seq = store.seed(grant.channel, frame.doc, frame.payload);
			// Concurrent seeds would double the text: the loser gets the room to merge into.
			if (seq === null) sendState(peer, grant, frame.slot, frame.doc, 0);
			else logged(context, frame, seq);
		}),
		[EFrame.Awareness]: live(({ peers, peer, grant }, { doc, payload }) =>
			toFollowers(
				peers,
				grant.channel,
				doc,
				peer,
				peerFrame(peer.tag, payload),
			),
		),
		[EFrame.Snapshot]: write(({ grant }, { doc, upto, payload }) =>
			store.compact(grant.channel, doc, payload, upto),
		),
		[EFrame.Rotate]: write(({ peers, peer, grant }, frame) => {
			const { slot, doc, target, upto, note, payload } = frame;
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
			if (!store.rotate(grant.channel, doc, pointer, upto, payload)) {
				sendState(peer, grant, slot, doc, upto);
				return;
			}
			// The rotator follows too: this is its confirmation.
			broadcast(peers, grant.channel, movedFrame(0, doc, pointer), (at, slot) =>
				follows(at, slot, doc),
			);
		}),
	};
}

/** Tells the followers of each document the socket follows (on one slot, if given) that it left. */
export function leaveDocs(peers: Peers, peer: HubPeer, slot?: number): void {
	for (const [at, doc] of peer.subs) {
		const grant = peer.slots[at];
		if (!grant || (slot !== undefined && at !== slot)) continue;
		toFollowers(peers, grant.channel, doc, peer, leaveFrame(peer.tag));
	}
}

/** Unanswered, a dropped frame looks like a slow one: the client would wait forever. */
export function refuse(
	peer: HubPeer,
	{ slot, doc }: { slot: number; doc: string },
	reason: Refusal,
): void {
	peer.send(encodeServer(refusedFrame(slot, doc, reason)));
}

/** The echo is the sender's ack; resending unacked updates is safe in Yjs. */
function logged(
	{ peers, peer, grant }: HandlerContext,
	{ slot, doc, payload }: { slot: number; doc: string; payload: Uint8Array },
	seq: number,
): void {
	peer.send(encodeServer({ type: EFrame.Echo, slot, doc, seq }));
	toFollowers(peers, grant.channel, doc, peer, {
		type: EFrame.Fanout,
		seq,
		from: peer.tag,
		payload,
	});
}

function toFollowers(
	peers: Peers,
	channel: string,
	doc: string,
	sender: HubPeer,
	body: ServerBody,
): void {
	broadcast(
		peers,
		channel,
		addressed(body, doc),
		(peer, slot) => peer.tag !== sender.tag && follows(peer, slot, doc),
	);
}
