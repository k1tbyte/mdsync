/**
 * The relay's one Durable Object: every socket of this deployment, each
 * carrying the channels the worker admitted it to. Socket state lives in its
 * attachment and document logs in SQLite, so it hibernates between frames and
 * pings never wake it; an alarm sweeps stale sockets while any are open.
 */

import { DurableObject } from "cloudflare:workers";
import { KEEPALIVE_PING, KEEPALIVE_PONG } from "@obsync/protocol";

import { HubCore } from "./hub-core";
import type { DocSub, Grant, HubPeer } from "./hub-peer";
import { SqlDocStore } from "./hub-store";

/** Carries the worker's admission to the hub; only the worker can reach the hub. */
export const HUB_ADMISSION_HEADER = "X-Obsync-Admission";
/** A deployment is one trust domain, so one hub serves all of it. */
const HUB_NAME = "hub";
/** Clients ping every 30 s: this much silence is two missed pings and a late third. */
const STALE_MS = 75_000;
const STALE_CLOSE_CODE = 1001;

export interface Admission {
	device: string;
	slots: (Grant | null)[];
}

interface Attachment extends Admission {
	tag: number;
	subs: DocSub[];
	joinedAt: number;
}

export interface HubEnv {
	HUB: DurableObjectNamespace<Hub>;
	/** Overrides the stale-socket window; only tests set it. */
	HUB_STALE_MS?: string;
}

export class Hub extends DurableObject<HubEnv> {
	private readonly core = new HubCore(
		() => this.open().map(peerOf),
		new SqlDocStore(this.ctx.storage.sql),
	);
	private readonly staleMs: number;

	constructor(ctx: DurableObjectState, env: HubEnv) {
		super(ctx, env);
		ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair(KEEPALIVE_PING, KEEPALIVE_PONG),
		);
		this.staleMs = Number(env.HUB_STALE_MS) || STALE_MS;
	}

	async fetch(request: Request): Promise<Response> {
		const admission = request.headers.get(HUB_ADMISSION_HEADER);
		const upgrade = request.headers.get("Upgrade")?.toLowerCase();
		if (!admission || upgrade !== "websocket") {
			return new Response("Obsync relay hub. Connect via WebSocket.", {
				status: 426,
			});
		}
		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({
			...(JSON.parse(admission) as Admission),
			tag: newTag(),
			subs: [],
			joinedAt: Date.now(),
		} satisfies Attachment);
		this.core.join(peerOf(server));
		// An alarm set under a longer window would leave this one's ghosts waiting.
		const sweep = await this.ctx.storage.getAlarm();
		if (sweep === null || sweep > Date.now() + this.staleMs) {
			await this.sweepLater();
		}
		return new Response(null, { status: 101, webSocket: client });
	}

	webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): void {
		if (typeof message === "string") return;
		this.core.handle(peerOf(ws), new Uint8Array(message));
	}

	webSocketClose(ws: WebSocket): void {
		this.leave(ws);
	}

	webSocketError(ws: WebSocket): void {
		this.leave(ws);
	}

	/**
	 * Keepalives never wake the hub, so a half-open socket would stay in every
	 * presence list until the runtime noticed. Its missing pings give it away.
	 */
	async alarm(): Promise<void> {
		const cutoff = Date.now() - this.staleMs;
		for (const ws of this.open()) {
			const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws);
			const state = ws.deserializeAttachment() as Attachment;
			if (Math.max(pinged?.getTime() ?? 0, state.joinedAt) > cutoff) continue;
			this.core.leave(peerOf(ws));
			ws.close(STALE_CLOSE_CODE, "Stale");
		}
		if (this.open().length > 0) await this.sweepLater();
	}

	/** RPC from the broker when a share token is revoked or replaced. */
	dropGrant(fingerprint: string): void {
		this.core.dropGrant(fingerprint);
	}

	/** RPC from the worker's HTTP signal route. */
	signal(channel: string, exceptDevice: string): void {
		this.core.signal(channel, exceptDevice);
	}

	/** A socket the hub closed stays listed, without its attachment, until the close completes. */
	private open(): WebSocket[] {
		return this.ctx
			.getWebSockets()
			.filter((ws) => ws.readyState === WebSocket.OPEN);
	}

	/** Closing drops the attachment; a socket the hub closed was announced gone then. */
	private leave(ws: WebSocket): void {
		if (ws.deserializeAttachment()) this.core.leave(peerOf(ws));
	}

	private sweepLater(): Promise<void> {
		return this.ctx.storage.setAlarm(Date.now() + this.staleMs);
	}
}

export function hubStub(env: HubEnv): DurableObjectStub<Hub> {
	return env.HUB.get(env.HUB.idFromName(HUB_NAME));
}

function peerOf(ws: WebSocket): HubPeer {
	const state = ws.deserializeAttachment() as Attachment;
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
