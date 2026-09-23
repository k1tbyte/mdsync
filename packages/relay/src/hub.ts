/**
 * The relay's one Durable Object: every socket of this deployment, each
 * carrying the channels the worker admitted it to. Socket state lives in its
 * attachment and document logs in SQLite, so it hibernates between frames and
 * pings never wake it.
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

export interface Admission {
	device: string;
	slots: (Grant | null)[];
}

interface Attachment extends Admission {
	tag: number;
	subs: DocSub[];
}

export interface HubEnv {
	HUB: DurableObjectNamespace<Hub>;
}

export class Hub extends DurableObject<HubEnv> {
	private readonly core = new HubCore(
		() => this.ctx.getWebSockets().map(peerOf),
		new SqlDocStore(this.ctx.storage.sql),
	);

	constructor(ctx: DurableObjectState, env: HubEnv) {
		super(ctx, env);
		ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair(KEEPALIVE_PING, KEEPALIVE_PONG),
		);
	}

	fetch(request: Request): Response {
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
		} satisfies Attachment);
		this.core.join(peerOf(server));
		return new Response(null, { status: 101, webSocket: client });
	}

	webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): void {
		if (typeof message === "string") return;
		this.core.handle(peerOf(ws), new Uint8Array(message));
	}

	webSocketClose(ws: WebSocket): void {
		this.core.leave(peerOf(ws));
	}

	webSocketError(ws: WebSocket): void {
		this.core.leave(peerOf(ws));
	}

	/** RPC from the broker when a share token is revoked or replaced. */
	dropGrant(fingerprint: string): void {
		this.core.dropGrant(fingerprint);
	}

	/** RPC from the worker's HTTP signal route. */
	signal(channel: string, exceptDevice: string): void {
		this.core.signal(channel, exceptDevice);
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
