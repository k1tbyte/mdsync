import {
	type ClientFrame,
	decodeServer,
	EFrame,
	encodeClient,
} from "@obsync/protocol";
import { HubCore } from "obsync-relay/src/hub/core";
import type { DocSub, HubPeer } from "obsync-relay/src/hub/peer";
import { SqlDocStore } from "obsync-relay/src/hub/store";
import { memorySql } from "obsync-relay/tests/helpers/memory-sql";

import type { SpaceFrame, SpaceHub, SpaceListener } from "@/hub/connection";

/**
 * The relay's own hub logic over a real SQLite store, in-process. Frames cross
 * the "wire" on a later macrotask, as over a socket, unless a test holds them.
 */
export class LiveHub {
	readonly peers = new Set<HubPeer>();
	private core = this.freshCore();
	private nextTag = 1;

	/** A read-only one is refused every write, as a read-only share token is. */
	connection(readOnly = false): TestConnection {
		return new TestConnection(this, readOnly);
	}

	/** A wiped Durable Object: logs gone, every socket closed. */
	wipe(): void {
		for (const peer of [...this.peers]) peer.close(1012, "restart");
		this.core = this.freshCore();
	}

	attach(
		receive: (bytes: Uint8Array) => void,
		close: () => void,
		readOnly = false,
	): HubPeer {
		let subs: DocSub[] = [];
		const grant = { channel: "vault", grant: "grant", who: "owner" };
		const peer: HubPeer = {
			tag: this.nextTag++,
			device: "device",
			slots: [readOnly ? { ...grant, readOnly } : grant],
			get subs() {
				return subs;
			},
			send: receive,
			revoke() {},
			subscribe(slot, doc) {
				subs = [...subs, [slot, doc]];
			},
			unsubscribe(slot, doc) {
				subs = subs.filter(([at, followed]) => at !== slot || followed !== doc);
			},
			close,
		};
		this.peers.add(peer);
		this.core.join(peer);
		return peer;
	}

	handle(peer: HubPeer, frame: ClientFrame): void {
		this.core.handle(peer, encodeClient(frame));
	}

	detach(peer: HubPeer): void {
		if (!this.peers.delete(peer)) return;
		this.core.leave(peer);
	}

	private freshCore(): HubCore {
		return new HubCore(() => [...this.peers], new SqlDocStore(memorySql()));
	}
}

/** One device's socket, reconnectable, with switches that make it half-open. */
/** One device's socket carrying one space, at slot 0. */
export class TestConnection implements SpaceHub {
	private readonly listeners = new Set<SpaceListener>();
	private peer: HubPeer | null = null;
	/** Counts sockets, so frames still on the wire die with theirs. */
	private socket = 0;
	private deaf = false;
	private mute = false;
	private updatesToDrop = 0;

	constructor(
		private readonly hub: LiveHub,
		private readonly readOnly: boolean,
	) {}

	isConnected(): boolean {
		return this.peer !== null;
	}

	/** Stands in for a whole HubConnection with this one space. */
	space(): SpaceHub {
		return this;
	}

	listen(listener: SpaceListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	send(frame: SpaceFrame): void {
		if (frame.type === EFrame.Update && this.updatesToDrop > 0) {
			this.updatesToDrop--;
			return;
		}
		if (this.peer && !this.mute) {
			this.hub.handle(this.peer, { ...frame, slot: 0 } as ClientFrame);
		}
	}

	connect(): void {
		this.socket++;
		this.deaf = false;
		this.mute = false;
		this.peer = this.hub.attach(
			(bytes) => this.receive(bytes),
			() => this.disconnect(),
			this.readOnly,
		);
		for (const listener of this.listeners) {
			listener.onConnectionChange?.(true);
		}
	}

	disconnect(): void {
		const peer = this.peer;
		if (peer) this.hub.detach(peer);
		this.drop();
	}

	/** Dies silently: the hub keeps the socket until the returned call ends it, as the relay does past its silence window. */
	strand(): () => void {
		const peer = this.peer;
		this.drop();
		return () => peer && this.hub.detach(peer);
	}

	/** Until the next socket, what the hub sends never arrives. */
	dropIncoming(): void {
		this.deaf = true;
	}

	/** The next `count` updates vanish unanswered, as past the hub's rate. */
	dropUpdates(count: number): void {
		this.updatesToDrop = count;
	}

	/** Until the next socket, what this device sends never arrives. */
	dropOutgoing(): void {
		this.mute = true;
	}

	private drop(): void {
		if (!this.peer) return;
		this.socket++;
		this.peer = null;
		for (const listener of this.listeners) {
			listener.onConnectionChange?.(false);
		}
	}

	private receive(bytes: Uint8Array): void {
		const frame = decodeServer(bytes);
		const socket = this.socket;
		if (!frame || this.deaf) return;
		setTimeout(() => {
			if (socket !== this.socket) return;
			for (const listener of this.listeners) listener.onFrame?.(frame);
		}, 0);
	}
}
