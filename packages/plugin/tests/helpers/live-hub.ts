import { type ClientFrame, decodeServer, encodeClient } from "@obsync/protocol";
import { HubCore } from "obsync-relay/src/hub-core";
import type { DocSub, HubPeer } from "obsync-relay/src/hub-peer";
import { SqlDocStore } from "obsync-relay/src/hub-store";
import { memorySql } from "obsync-relay/tests/helpers/memory-sql";

import type { HubConnection, HubListener } from "@/hub/connection";

/**
 * The relay's own hub logic over a real SQLite store, in-process. Frames cross
 * the "wire" on a later macrotask, as over a socket, unless a test holds them.
 */
export class LiveHub {
	readonly peers = new Set<HubPeer>();
	private core = this.freshCore();
	private nextTag = 1;

	connection(): TestConnection {
		return new TestConnection(this);
	}

	/** A wiped Durable Object: logs gone, every socket closed. */
	wipe(): void {
		for (const peer of [...this.peers]) peer.close(1012, "restart");
		this.core = this.freshCore();
	}

	attach(receive: (bytes: Uint8Array) => void, close: () => void): HubPeer {
		let subs: DocSub[] = [];
		const peer: HubPeer = {
			tag: this.nextTag++,
			device: "device",
			slots: [{ channel: "vault", grant: "grant", who: "owner" }],
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
		return new HubCore(() => this.peers, new SqlDocStore(memorySql()));
	}
}

/** One device's socket, reconnectable, with switches that make it half-open. */
export class TestConnection
	implements Pick<HubConnection, "send" | "isConnected" | "listen">
{
	private readonly listeners = new Set<HubListener>();
	private peer: HubPeer | null = null;
	/** Counts sockets, so frames still on the wire die with theirs. */
	private socket = 0;
	private deaf = false;
	private mute = false;

	constructor(private readonly hub: LiveHub) {}

	isConnected(): boolean {
		return this.peer !== null;
	}

	listen(listener: HubListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	send(frame: ClientFrame): void {
		if (this.peer && !this.mute) this.hub.handle(this.peer, frame);
	}

	connect(): void {
		this.socket++;
		this.deaf = false;
		this.mute = false;
		this.peer = this.hub.attach(
			(bytes) => this.receive(bytes),
			() => this.disconnect(),
		);
		for (const listener of this.listeners) {
			listener.onConnectionChange?.(true);
		}
	}

	disconnect(): void {
		if (!this.peer) return;
		this.socket++;
		this.hub.detach(this.peer);
		this.peer = null;
		for (const listener of this.listeners) {
			listener.onConnectionChange?.(false);
		}
	}

	/** Until the next socket, what the hub sends never arrives. */
	dropIncoming(): void {
		this.deaf = true;
	}

	/** Until the next socket, what this device sends never arrives. */
	dropOutgoing(): void {
		this.mute = true;
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
