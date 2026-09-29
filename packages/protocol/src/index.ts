/**
 * Wire format between the plugin and the relay hub. Every frame is
 * `[type:u8][slot:u8][docLen:u8][doc][body]`: the slot names a channel within
 * one socket, the doc is an opaque HMAC ("" addresses the whole channel), and
 * payloads are ciphertext the hub never reads.
 */

import { Reader, Writer } from "./bytes";

export { toHex } from "./bytes";
export { deriveChannelGrant } from "./grant";
export { shareChannel, sharePrefix } from "./share";

/** The hub route; `/hub/signal` is its HTTP fallback for the cold-sync ping. */
export const HUB_PATH = "/hub";
export const HUB_SIGNAL_PATH = "/hub/signal";
/** Query keys: one `c`/`t` pair per slot, in slot order, plus the device id. */
export const EHubParam = {
	Channel: "c",
	Token: "t",
	Device: "d",
} as const;
/** Answered by the hub without waking it; any reply keeps a link's silence timer quiet. */
export const KEEPALIVE_PING = "ping";
export const KEEPALIVE_PONG = "pong";
/** Terminal for a whole socket: no channel it asked for was granted. */
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
/** Channels one socket may carry; the hub admits none past it. */
export const MAX_SLOTS = 32;
/** A blind hub cannot tell a large edit from abuse; it can only cap the frame. */
export const MAX_FRAME_BYTES = 1024 * 1024;
/** Documents one socket may follow: the hub keeps them in a 16 KB attachment. */
export const MAX_DOC_SUBS = 64;
/** A docId is 32 hex chars; anything much longer is not one. */
export const MAX_DOC_ID_LENGTH = 64;

interface Address {
	slot: number;
	doc: string;
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
		 * pointer, as one step, only while the log still ends at `upto`.
		 */
		| {
				type: typeof EFrame.Rotate;
				target: string;
				upto: number;
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
		| { type: typeof EFrame.Join; from: number; who: string }
		| { type: typeof EFrame.Leave; from: number }
		| { type: typeof EFrame.Moved; target: string }
		| { type: typeof EFrame.Revoked }
		| { type: typeof EFrame.Refused; reason: Refusal }
		| { type: typeof EFrame.Signal; from: number }
	);

type Body<F, K> = Omit<Extract<F, { type: K }>, keyof Address | "type">;

type Codec<F extends { type: number }> = {
	[K in F["type"]]: {
		write(frame: Extract<F, { type: K }>, out: Writer): void;
		read(input: Reader): Body<F, K>;
	};
};

const none = { write() {}, read: () => ({}) };

const CLIENT: Codec<ClientFrame> = {
	[EFrame.Sub]: {
		write: (f, out) => out.u32(f.since),
		read: (input) => ({ since: input.u32() }),
	},
	[EFrame.Unsub]: none,
	[EFrame.Update]: {
		write: (f, out) => out.bytes(f.payload),
		read: (input) => ({ payload: input.rest() }),
	},
	[EFrame.Awareness]: {
		write: (f, out) => out.bytes(f.payload),
		read: (input) => ({ payload: input.rest() }),
	},
	[EFrame.Snapshot]: {
		write: (f, out) => out.u32(f.upto).bytes(f.payload),
		read: (input) => ({ upto: input.u32(), payload: input.rest() }),
	},
	[EFrame.Rotate]: {
		write: (f, out) => out.text(f.target).u32(f.upto).bytes(f.payload),
		read: (input) => ({
			target: input.text(),
			upto: input.u32(),
			payload: input.rest(),
		}),
	},
	[EFrame.Signal]: none,
	[EFrame.Seed]: {
		write: (f, out) => out.bytes(f.payload),
		read: (input) => ({ payload: input.rest() }),
	},
};

const SERVER: Codec<ServerFrame> = {
	[EFrame.State]: {
		write: (f, out) => {
			out
				.u32(f.head)
				.block(f.snapshot ?? new Uint8Array())
				.u32(f.deltas.length);
			for (const delta of f.deltas) out.block(delta);
			// Last, so an older reader never sees it.
			out.text(f.log);
		},
		read: (input) => {
			const head = input.u32();
			const snapshot = input.block();
			const deltas: Uint8Array[] = [];
			for (let left = input.u32(); left > 0; left--) deltas.push(input.block());
			const log = input.more() ? input.text() : "";
			return {
				head,
				snapshot: snapshot.length > 0 ? snapshot : null,
				deltas,
				log,
			};
		},
	},
	[EFrame.Fanout]: {
		write: (f, out) => out.u32(f.seq).u32(f.from).bytes(f.payload),
		read: (input) => ({
			seq: input.u32(),
			from: input.u32(),
			payload: input.rest(),
		}),
	},
	[EFrame.Echo]: {
		write: (f, out) => out.u32(f.seq),
		read: (input) => ({ seq: input.u32() }),
	},
	[EFrame.Peer]: {
		write: (f, out) => out.u32(f.from).bytes(f.payload),
		read: (input) => ({ from: input.u32(), payload: input.rest() }),
	},
	[EFrame.Join]: {
		write: (f, out) => out.u32(f.from).text(f.who),
		read: (input) => ({ from: input.u32(), who: input.text() }),
	},
	[EFrame.Leave]: {
		write: (f, out) => out.u32(f.from),
		read: (input) => ({ from: input.u32() }),
	},
	[EFrame.Moved]: {
		write: (f, out) => out.text(f.target),
		read: (input) => ({ target: input.text() }),
	},
	[EFrame.Revoked]: none,
	[EFrame.Refused]: {
		write: (f, out) => out.u8(f.reason),
		read: (input) => ({ reason: input.u8() as Refusal }),
	},
	[EFrame.Signal]: {
		write: (f, out) => out.u32(f.from),
		read: (input) => ({ from: input.u32() }),
	},
};

export function encodeClient(frame: ClientFrame): Uint8Array<ArrayBuffer> {
	return encode(CLIENT, frame);
}

export function encodeServer(frame: ServerFrame): Uint8Array<ArrayBuffer> {
	return encode(SERVER, frame);
}

/** Null for anything malformed: neither side may trust what arrives. */
export function decodeClient(bytes: Uint8Array): ClientFrame | null {
	return decode(CLIENT, bytes);
}

export function decodeServer(bytes: Uint8Array): ServerFrame | null {
	return decode(SERVER, bytes);
}

/** Readdresses an encoded frame to another socket's slot for the same channel. */
export function withSlot(
	bytes: Uint8Array,
	slot: number,
): Uint8Array<ArrayBuffer> {
	const out = bytes.slice();
	out[1] = slot;
	return out;
}

function encode<F extends ClientFrame | ServerFrame>(
	codec: Codec<F>,
	frame: F,
): Uint8Array<ArrayBuffer> {
	const out = new Writer().u8(frame.type).u8(frame.slot).text(frame.doc);
	const entry = codec[frame.type as F["type"]] as {
		write(frame: F, out: Writer): void;
	};
	entry.write(frame, out);
	return out.finish();
}

function decode<F extends ClientFrame | ServerFrame>(
	codec: Codec<F>,
	bytes: Uint8Array,
): F | null {
	try {
		const input = new Reader(bytes);
		const type = input.u8();
		const slot = input.u8();
		const doc = input.text();
		const entry = (codec as Record<number, { read(input: Reader): object }>)[
			type
		];
		if (!entry) return null;
		return { type, slot, doc, ...entry.read(input) } as F;
	} catch {
		return null;
	}
}
