/**
 * The relay's one Durable Object. Socket state lives in attachments and document logs in SQLite, so it
 * hibernates between frames and pings never wake it.
 */

import { DurableObject } from "cloudflare:workers";
import {
	KEEPALIVE_PING,
	KEEPALIVE_PONG,
	KEEPALIVE_STALE_MS,
} from "@obsync/protocol";

import { HubCore } from "./core";
import type { DocSub, Grant, HubPeer } from "./peer";
import { RevokedGrants } from "./revoked";
import { SqlDocStore } from "./store";
import { type HubEnv, unauthorizedSocket } from "./stub";

/** Carries the worker's admission to the hub; only the worker can reach the hub. */
export const HUB_ADMISSION_HEADER = "X-Obsync-Admission";
const STALE_CLOSE_CODE = 1001;

export interface Admission {
	device: string;
	slots: (Grant | null)[];
}

interface Attachment extends Admission {
	tag: number;
	subs: DocSub[];
	joinedAt: number;
	left?: true;
}

export class Hub extends DurableObject<HubEnv> {
	private readonly core = new HubCore(
		() => this.open().map(({ peer }) => peer),
		new SqlDocStore(this.ctx.storage.sql),
	);
	private readonly revoked = new RevokedGrants(this.ctx.storage.sql);
	private readonly staleMs: number;
	private readonly sweepMs: number;

	constructor(ctx: DurableObjectState, env: HubEnv) {
		super(ctx, env);
		ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair(KEEPALIVE_PING, KEEPALIVE_PONG),
		);
		this.staleMs = Number(env.HUB_STALE_MS) || KEEPALIVE_STALE_MS;
		this.sweepMs = this.staleMs / 2;
	}

	async fetch(request: Request): Promise<Response> {
		const header = request.headers.get(HUB_ADMISSION_HEADER);
		const upgrade = request.headers.get("Upgrade")?.toLowerCase();
		if (!header || upgrade !== "websocket") {
			return new Response("Obsync relay hub. Connect via WebSocket.", {
				status: 426,
			});
		}
		const admission = JSON.parse(header) as Admission;
		const slots = this.revoked.refuse(admission.slots);
		if (!slots.some((slot) => slot !== null)) return unauthorizedSocket();
		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
		const state: Attachment = {
			...admission,
			slots,
			tag: newTag(),
			subs: [],
			joinedAt: Date.now(),
		};
		server.serializeAttachment(state);
		this.core.join(attach(server, state).peer);
		// An alarm set under a longer window would leave this one's ghosts waiting.
		const sweep = await this.ctx.storage.getAlarm();
		if (sweep === null || sweep > Date.now() + this.sweepMs) {
			await this.sweepLater();
		}
		return new Response(null, { status: 101, webSocket: client });
	}

	webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): void {
		if (typeof message === "string") return;
		const entry = attachedOf(ws);
		if (entry) this.core.handle(entry.peer, new Uint8Array(message));
	}

	webSocketClose(ws: WebSocket): void {
		this.leave(ws);
	}

	webSocketError(ws: WebSocket): void {
		this.leave(ws);
	}

	/**
	 * Keepalives never wake the hub, so missing pings are the only sign of a half-open socket; sweeping
	 * twice per window bounds a ghost's life at 1.5 windows.
	 */
	async alarm(): Promise<void> {
		const cutoff = Date.now() - this.staleMs;
		for (const { ws, state } of this.open()) {
			const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws);
			if (Math.max(pinged?.getTime() ?? 0, state.joinedAt) > cutoff) continue;
			this.leave(ws);
			ws.close(STALE_CLOSE_CODE, "Stale");
		}
		if (this.open().length > 0) await this.sweepLater();
	}

	/** RPC from the broker when a share token is revoked or replaced. */
	dropGrant(fingerprint: string): void {
		this.revoked.add(fingerprint);
		this.core.dropGrant(fingerprint);
	}

	/** RPC from the broker when a share ends: its rows go and its channel stays shut. */
	purgeChannel(channel: string): void {
		this.revoked.closeChannel(channel);
		this.core.closeChannel(channel);
	}

	/** RPC from the worker's HTTP signal route. */
	signal(channel: string, exceptDevice: string): void {
		this.core.signal(channel, exceptDevice);
	}

	/** A socket the hub closed stays listed, without its attachment, until the close completes. */
	private open(): Attached[] {
		const open: Attached[] = [];
		for (const ws of this.ctx.getWebSockets()) {
			const entry = ws.readyState === WebSocket.OPEN ? attachedOf(ws) : null;
			if (entry) open.push(entry);
		}
		return open;
	}

	/** Announces once: the close event of a socket the hub swept must not repeat it. */
	private leave(ws: WebSocket): void {
		const entry = attachedOf(ws);
		if (!entry || entry.state.left) return;
		this.core.leave(entry.peer);
		entry.state.left = true;
		ws.serializeAttachment(entry.state);
	}

	private sweepLater(): Promise<void> {
		return this.ctx.storage.setAlarm(Date.now() + this.sweepMs);
	}
}

interface Attached {
	ws: WebSocket;
	state: Attachment;
	peer: HubPeer;
}

/**
 * One object per socket: reading a 16 KB attachment and rebuilding its peer for every socket on every frame
 * was the hub's hot path.
 */
const attached = new WeakMap<WebSocket, Attached>();

function attach(ws: WebSocket, state: Attachment): Attached {
	const entry = { ws, state, peer: peerOver(ws, state) };
	attached.set(ws, entry);
	return entry;
}

function attachedOf(ws: WebSocket): Attached | null {
	const known = attached.get(ws);
	if (known) return known;
	const state = ws.deserializeAttachment() as Attachment | null;
	return state ? attach(ws, state) : null;
}

function peerOver(ws: WebSocket, state: Attachment): HubPeer {
	const keepSubs = (keep: (sub: DocSub) => boolean) => {
		state.subs = state.subs.filter(keep);
		ws.serializeAttachment(state);
	};
	return {
		tag: state.tag,
		device: state.device,
		slots: state.slots,
		get subs() {
			return state.subs;
		},
		send(bytes) {
			// A socket mid-close throws; its own close handler announces the departure.
			try {
				ws.send(bytes);
			} catch {}
		},
		revoke(slot) {
			state.slots[slot] = null;
			keepSubs(([at]) => at !== slot);
		},
		subscribe(slot, doc) {
			state.subs.push([slot, doc]);
			ws.serializeAttachment(state);
		},
		unsubscribe(slot, doc) {
			keepSubs(([at, followed]) => at !== slot || followed !== doc);
		},
		close(code, reason) {
			ws.close(code, reason);
		},
	};
}

/** Non-zero: zero marks a signal no socket sent. */
function newTag(): number {
	const [tag = 0] = crypto.getRandomValues(new Uint32Array(1));
	return tag === 0 ? 1 : tag;
}
