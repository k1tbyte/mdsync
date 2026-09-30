/**
 * Wire format between the plugin and the relay hub. Every frame is
 * `[type:u8][slot:u8][docLen:u8][doc][body]`: the slot names a channel within
 * one socket, the doc is an opaque HMAC ("" addresses the whole channel), and
 * payloads are ciphertext the hub never reads.
 */

export const HUB_PATH = "/hub";
export const HUB_SIGNAL_PATH = "/hub/signal";
/** One `c`/`t` pair per slot, in slot order, plus the device id. */
export const EHubParam = {
	Channel: "c",
	Token: "t",
	Device: "d",
} as const;

/** Answered by the hub without waking it. */
export const KEEPALIVE_PING = "ping";
export const KEEPALIVE_PONG = "pong";
export const KEEPALIVE_INTERVAL_MS = 30_000;
export const KEEPALIVE_STALE_MS = 2.5 * KEEPALIVE_INTERVAL_MS;
export const KEEPALIVE_SILENCE_MS = 3 * KEEPALIVE_INTERVAL_MS;

export const UNAUTHORIZED_CLOSE_CODE = 4001;
/** `who` of a socket the deployment secret admitted: the vault's owner. */
export const OWNER = "owner";

export const EFrame = {
	Sub: 1,
	Unsub: 2,
	Update: 3,
	Awareness: 4,
	Snapshot: 5,
	Rotate: 6,
	Signal: 7,
	Seed: 8,
	State: 16,
	Fanout: 17,
	Echo: 18,
	Peer: 19,
	Join: 20,
	Leave: 21,
	Moved: 22,
	Revoked: 23,
	Refused: 24,
	/** Someone already on the channel, told to a newcomer; `Join` is someone arriving. */
	Here: 25,
} as const;

/** Why the hub dropped a document frame: the client stops waiting on it. */
export const ERefusal = {
	TooLarge: 1,
	TooManyDocs: 2,
	ReadOnly: 3,
} as const;
export type Refusal = (typeof ERefusal)[keyof typeof ERefusal];

/** Addresses the channel itself: presence and the cold-sync signal. */
export const CHANNEL_DOC = "";
export const MAX_SLOTS = 32;
/** A blind hub cannot tell a large edit from abuse; it can only cap the frame. */
export const MAX_FRAME_BYTES = 1024 * 1024;
/** Documents one socket may follow: the hub keeps them in a 16 KB attachment. */
export const MAX_DOC_SUBS = 64;
/** A docId is 32 hex chars. */
export const MAX_DOC_ID_LENGTH = 64;
/** A sealed path is short; the hub keeps every note it holds in memory too. */
export const MAX_MOVE_NOTE_BYTES = 4 * 1024;

export interface Address {
	slot: number;
	doc: string;
}

/** A socket as the hub vouches for it: its grant's `who`, and the name its share token carries (""). */
export interface Vouched {
	from: number;
	who: string;
	name: string;
}

export type ClientFrame = Address &
	(
		| { type: typeof EFrame.Sub; since: number }
		| { type: typeof EFrame.Unsub }
		| { type: typeof EFrame.Update; payload: Uint8Array }
		| { type: typeof EFrame.Awareness; payload: Uint8Array }
		| { type: typeof EFrame.Snapshot; upto: number; payload: Uint8Array }
		/**
		 * Seeds `target` with the rebuilt document and seals this one with a
		 * pointer, as one step, only while the log still ends at `upto`. `note`
		 * goes out with the pointer: sealed, empty unless the note moved path.
		 */
		| {
				type: typeof EFrame.Rotate;
				target: string;
				upto: number;
				note: Uint8Array;
				payload: Uint8Array;
		  }
		| { type: typeof EFrame.Signal }
		/** An Update the hub takes only into a document with no log. */
		| { type: typeof EFrame.Seed; payload: Uint8Array }
	);

export type ServerFrame = Address &
	(
		| {
				type: typeof EFrame.State;
				head: number;
				snapshot: Uint8Array | null;
				deltas: Uint8Array[];
				/** Names the log: one lost and grown again has another. "" from a relay without it. */
				log: string;
		  }
		| {
				type: typeof EFrame.Fanout;
				seq: number;
				from: number;
				payload: Uint8Array;
		  }
		| { type: typeof EFrame.Echo; seq: number }
		| { type: typeof EFrame.Peer; from: number; payload: Uint8Array }
		| ({ type: typeof EFrame.Join } & Vouched)
		| ({ type: typeof EFrame.Here } & Vouched)
		| { type: typeof EFrame.Leave; from: number }
		| { type: typeof EFrame.Moved; target: string; note: Uint8Array }
		| { type: typeof EFrame.Revoked }
		| { type: typeof EFrame.Refused; reason: Refusal }
		| { type: typeof EFrame.Signal; from: number }
	);
