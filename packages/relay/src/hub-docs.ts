/**
 * Live documents inside a channel. The hub keeps each document's encrypted log
 * and never reads it: clients merge, the hub only orders updates, keeps what a
 * client snapshot covers and forwards the rest to the document's followers.
 */

import {
	type ClientFrame,
	EFrame,
	encodeServer,
	MAX_DOC_ID_LENGTH,
	MAX_DOC_SUBS,
	type ServerFrame,
} from "@obsync/protocol";

import {
	broadcast,
	follows,
	type Handler,
	type Handlers,
	type HubPeer,
	type Peers,
} from "./hub-peer";

export interface DocState {
	head: number;
	snapshot: Uint8Array | null;
	deltas: Uint8Array[];
}

export interface DocStore {
	/** The document it continued as, or null while it is live. */
	movedTo(channel: string, doc: string): string | null;
	/** Drops the log: from here the pointer is the only answer. */
	markMoved(channel: string, doc: string, target: string): void;
	append(channel: string, doc: string, payload: Uint8Array): number;
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
			const target = store.movedTo(grant.channel, frame.doc);
			if (target !== null) {
				peer.send(encodeServer(movedFrame(frame.slot, frame.doc, target)));
				return;
			}
			handler(context, frame);
		};

	return {
		[EFrame.Sub]: ({ peers, peer, grant }, { slot, doc, since }) => {
			if (doc.length > MAX_DOC_ID_LENGTH) return;
			const target = store.movedTo(grant.channel, doc);
			if (target !== null) {
				peer.send(encodeServer(movedFrame(slot, doc, target)));
				return;
			}
			const fresh = !follows(peer, slot, doc);
			if (fresh && peer.subs.length >= MAX_DOC_SUBS) return;
			if (fresh) peer.subscribe(slot, doc);
			peer.send(
				encodeServer({
					type: EFrame.State,
					slot,
					doc,
					...store.state(grant.channel, doc, since),
				}),
			);
			// Awareness is never stored, so followers re-announce for the newcomer.
			if (fresh) {
				toFollowers(peers, grant.channel, doc, peer, {
					type: EFrame.Join,
					from: peer.tag,
					who: grant.who,
				});
			}
		},
		[EFrame.Unsub]: ({ peers, peer, grant }, { slot, doc }) => {
			if (!follows(peer, slot, doc)) return;
			peer.unsubscribe(slot, doc);
			toFollowers(peers, grant.channel, doc, peer, leaveFrame(peer));
		},
		[EFrame.Update]: live(({ peers, peer, grant }, { slot, doc, payload }) => {
			const seq = store.append(grant.channel, doc, payload);
			// The echo is the sender's ack; resending unacked updates is safe in Yjs.
			peer.send(encodeServer({ type: EFrame.Echo, slot, doc, seq }));
			toFollowers(peers, grant.channel, doc, peer, {
				type: EFrame.Fanout,
				seq,
				from: peer.tag,
				payload,
			});
		}),
		[EFrame.Awareness]: live(({ peers, peer, grant }, { doc, payload }) =>
			toFollowers(peers, grant.channel, doc, peer, {
				type: EFrame.Peer,
				from: peer.tag,
				payload,
			}),
		),
		[EFrame.Snapshot]: live(({ grant }, { doc, upto, payload }) =>
			store.compact(grant.channel, doc, payload, upto),
		),
		[EFrame.Rotate]: live(({ peers, peer, grant }, { doc, target }) => {
			if (!target || target === doc || target.length > MAX_DOC_ID_LENGTH) {
				return;
			}
			store.markMoved(grant.channel, doc, target);
			toFollowers(peers, grant.channel, doc, peer, {
				type: EFrame.Moved,
				target,
			});
		}),
	};
}

/** Tells the followers of each document the socket follows (on one slot, if given) that it left. */
export function leaveDocs(peers: Peers, peer: HubPeer, slot?: number): void {
	for (const [at, doc] of peer.subs) {
		const grant = peer.slots[at];
		if (!grant || (slot !== undefined && at !== slot)) continue;
		toFollowers(peers, grant.channel, doc, peer, leaveFrame(peer));
	}
}

type Unaddressed<F> = F extends ServerFrame ? Omit<F, "slot" | "doc"> : never;

function toFollowers(
	peers: Peers,
	channel: string,
	doc: string,
	sender: HubPeer,
	frame: Unaddressed<ServerFrame>,
): void {
	broadcast(
		peers,
		channel,
		{ ...frame, slot: 0, doc } as ServerFrame,
		(peer, slot) => peer.tag !== sender.tag && follows(peer, slot, doc),
	);
}

function movedFrame(slot: number, doc: string, target: string): ServerFrame {
	return { type: EFrame.Moved, slot, doc, target };
}

function leaveFrame(peer: HubPeer): Unaddressed<ServerFrame> {
	return { type: EFrame.Leave, from: peer.tag };
}
