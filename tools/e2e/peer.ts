/** A scripted device on the relay hub, speaking the plugin's codec; one slot per `[channel, token]` pair, in order. */

import {
	CHANNEL_DOC,
	type ClientFrame,
	decodeServer,
	EFrame,
	EHubParam,
	encodeClient,
	HUB_PATH,
	type ServerFrame,
} from "@mdsync/protocol";

const WAIT_MS = 10_000;
const QUIET_MS = 500;

export type PeerEvent =
	| ServerFrame
	| { type: "text"; text: string }
	| { type: "close"; code: number };

type EventOf<T extends PeerEvent["type"]> = Extract<PeerEvent, { type: T }>;

export interface Peer {
	send(frame: ClientFrame): void;
	raw(text: string): void;
	announce(device: { id: string; name: string }, slot?: number): void;
	signal(slot?: number): void;
	next<T extends PeerEvent["type"]>(type: T, ms?: number): Promise<EventOf<T>>;
	/** True when no event of this type arrives within `ms`. */
	quiet(type: PeerEvent["type"], ms?: number): Promise<boolean>;
	close(): void;
}

export async function connectPeer(
	relayUrl: string,
	grants: readonly (readonly [channel: string, token: string])[],
	device: string,
): Promise<Peer> {
	const url = new URL(`${relayUrl.replace(/^http/, "ws")}${HUB_PATH}`);
	for (const [channel, token] of grants) {
		url.searchParams.append(EHubParam.Channel, channel);
		url.searchParams.append(EHubParam.Token, token);
	}
	url.searchParams.set(EHubParam.Device, device);

	const socket = new WebSocket(url);
	socket.binaryType = "arraybuffer";
	const inbox: PeerEvent[] = [];
	let notify: (() => void) | null = null;
	const push = (event: PeerEvent) => {
		inbox.push(event);
		notify?.();
	};
	socket.onmessage = (event) => {
		if (typeof event.data === "string") {
			push({ type: "text", text: event.data });
			return;
		}
		const frame = decodeServer(new Uint8Array(event.data as ArrayBuffer));
		if (frame) push(frame);
	};
	socket.onclose = (event) => push({ type: "close", code: event.code });
	await new Promise((resolve, reject) => {
		socket.onopen = resolve;
		socket.onerror = () => reject(new Error(`cannot reach ${url.origin}`));
	});

	const take = (type: PeerEvent["type"]) => {
		const at = inbox.findIndex((event) => event.type === type);
		return at < 0 ? null : (inbox.splice(at, 1)[0] as PeerEvent);
	};
	const send = (frame: ClientFrame) => socket.send(encodeClient(frame));
	return {
		send,
		raw: (text) => socket.send(text),
		announce: (device, slot = 0) =>
			send({
				type: EFrame.Awareness,
				slot,
				doc: CHANNEL_DOC,
				payload: new TextEncoder().encode(JSON.stringify(device)),
			}),
		signal: (slot = 0) => send({ type: EFrame.Signal, slot, doc: CHANNEL_DOC }),
		next: (type, ms = WAIT_MS) =>
			new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					notify = null;
					reject(new Error(`${device}: no ${type} within ${ms} ms`));
				}, ms);
				notify = () => {
					const event = take(type);
					if (!event) return;
					clearTimeout(timer);
					notify = null;
					resolve(event as never);
				};
				notify();
			}),
		quiet: async (type, ms = QUIET_MS) => {
			await new Promise((resolve) => setTimeout(resolve, ms));
			return take(type) === null;
		},
		close: () => socket.close(),
	};
}
