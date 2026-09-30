import { Reader, Writer } from "./bytes";
import {
	type Address,
	type ClientFrame,
	EFrame,
	type Refusal,
	type ServerFrame,
	type Vouched,
} from "./frames";

type Body<F, K> = Omit<Extract<F, { type: K }>, keyof Address | "type">;

const vouched = {
	write: (f: Vouched, out: Writer) => out.u32(f.from).text(f.who).text(f.name),
	read: (input: Reader): Vouched => ({
		from: input.u32(),
		who: input.text(),
		name: input.text(),
	}),
};

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
		write: (f, out) =>
			out.text(f.target).u32(f.upto).block(f.note).bytes(f.payload),
		read: (input) => ({
			target: input.text(),
			upto: input.u32(),
			note: input.block(),
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
			// Last: a reader from before it stops short.
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
	[EFrame.Join]: vouched,
	[EFrame.Here]: vouched,
	[EFrame.Leave]: {
		write: (f, out) => out.u32(f.from),
		read: (input) => ({ from: input.u32() }),
	},
	[EFrame.Moved]: {
		write: (f, out) => out.text(f.target).bytes(f.note),
		read: (input) => ({ target: input.text(), note: input.rest() }),
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

/** Null for anything malformed. */
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
