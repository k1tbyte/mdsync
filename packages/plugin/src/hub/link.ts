/**
 * One socket to a relay hub, carrying every channel this device holds there.
 * Channels are addressed by slot, their index in `channels`. Reconnects with
 * backoff; a link that stays silent past the timeout is treated as dead.
 */

import {
	CHANNEL_DOC,
	type ClientFrame,
	decodeServer,
	EFrame,
	EHubParam,
	encodeClient,
	HUB_PATH,
	HUB_SIGNAL_PATH,
	KEEPALIVE_PING,
	type ServerFrame,
	UNAUTHORIZED_CLOSE_CODE,
} from "@obsync/protocol";
import { requestUrl } from "obsidian";

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const PING_INTERVAL_MS = 30_000;
/** The hub answers every ping, so this much quiet means the link is gone. */
const SILENCE_TIMEOUT_MS = 90_000;

export interface HubChannel {
	channel: string;
	/** Channel grant derived from the relay secret, or a share token. */
	token: string;
}

export interface HubLinkOptions {
	serverUrl: string;
	/** In slot order; a promise because channels and grants are derived. */
	channels: Promise<readonly HubChannel[]>;
	/** Opaque; lets an HTTP signal skip this device's own socket. */
	deviceId: string;
	onFrame(frame: ServerFrame): void;
	onConnectionChange?(connected: boolean): void;
}

export class HubLink {
	private ws: WebSocket | null = null;
	private reconnectAttempts = 0;
	private reconnectTimer: number | null = null;
	private pingTimer: number | null = null;
	private disposed = false;
	private lastMessageAt = 0;

	constructor(private readonly options: HubLinkOptions) {}

	get connected(): boolean {
		return this.ws?.readyState === WebSocket.OPEN;
	}

	connect(): void {
		void this.openSocket();
	}

	/** Dropped while the link is down: every caller re-sends on reconnect. */
	send(frame: ClientFrame): void {
		if (!this.connected) return;
		try {
			this.ws?.send(encodeClient(frame));
		} catch {
			// A closing socket throws; its close handler takes over.
		}
	}

	/** The cold-sync ping, over HTTP when the socket is down. */
	signal(slot: number): void {
		if (this.disposed) return;
		if (this.connected) {
			this.send({ type: EFrame.Signal, slot, doc: CHANNEL_DOC });
			return;
		}
		void this.signalOverHttp(slot);
	}

	dispose(): void {
		this.disposed = true;
		this.cleanup();
	}

	private async openSocket(): Promise<void> {
		if (this.disposed) return;
		this.cleanup();

		let socket: WebSocket;
		try {
			// Settings hold the worker's https URL; the socket needs its ws twin.
			const base = this.options.serverUrl.replace(/^http(s)?:/, "ws$1:");
			socket = new WebSocket(await this.hubUrl(base));
		} catch {
			// A malformed server URL cannot be fixed by retrying.
			this.options.onConnectionChange?.(false);
			return;
		}
		if (this.disposed) {
			socket.close();
			return;
		}
		socket.binaryType = "arraybuffer";
		this.ws = socket;

		socket.addEventListener("open", () => {
			if (this.ws !== socket) return;
			this.reconnectAttempts = 0;
			this.lastMessageAt = Date.now();
			this.startPing();
			this.options.onConnectionChange?.(true);
		});
		socket.addEventListener("message", (event) => {
			if (this.ws !== socket) return;
			this.lastMessageAt = Date.now();
			// Text is only the keepalive's answer.
			if (!(event.data instanceof ArrayBuffer)) return;
			const frame = decodeServer(new Uint8Array(event.data));
			if (frame) this.options.onFrame(frame);
		});
		socket.addEventListener("close", (event) => {
			if (this.ws !== socket) return;
			this.stopPing();
			this.ws = null;
			this.options.onConnectionChange?.(false);
			// No channel was granted; retrying with the same grants cannot help.
			if (event.code === UNAUTHORIZED_CLOSE_CODE) return;
			this.scheduleReconnect();
		});
		socket.addEventListener("error", () => socket.close());
	}

	private async signalOverHttp(slot: number): Promise<void> {
		try {
			const channel = (await this.options.channels)[slot];
			if (!channel) return;
			const url = new URL(
				`${this.options.serverUrl.replace(/\/$/, "")}${HUB_SIGNAL_PATH}`,
			);
			url.searchParams.set(EHubParam.Channel, channel.channel);
			url.searchParams.set(EHubParam.Token, channel.token);
			url.searchParams.set(EHubParam.Device, this.options.deviceId);
			await requestUrl({ url: url.toString(), method: "POST", throw: false });
		} catch {
			// Best effort: a missed signal only delays the next pull.
		}
	}

	private async hubUrl(base: string): Promise<string> {
		const url = new URL(`${base.replace(/\/$/, "")}${HUB_PATH}`);
		for (const { channel, token } of await this.options.channels) {
			url.searchParams.append(EHubParam.Channel, channel);
			url.searchParams.append(EHubParam.Token, token);
		}
		url.searchParams.set(EHubParam.Device, this.options.deviceId);
		return url.toString();
	}

	private startPing(): void {
		this.stopPing();
		this.pingTimer = window.setInterval(() => {
			if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
			// Drops silently dead TCP links to trigger the reconnect path.
			if (Date.now() - this.lastMessageAt > SILENCE_TIMEOUT_MS) {
				this.ws.close();
				return;
			}
			this.ws.send(KEEPALIVE_PING);
		}, PING_INTERVAL_MS);
	}

	private stopPing(): void {
		if (this.pingTimer === null) return;
		window.clearInterval(this.pingTimer);
		this.pingTimer = null;
	}

	private cleanup(): void {
		this.stopPing();
		// A pending reconnect belongs to the socket being replaced.
		if (this.reconnectTimer !== null) {
			window.clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		const socket = this.ws;
		this.ws = null;
		try {
			socket?.close();
		} catch {
			// Already closing.
		}
	}

	private scheduleReconnect(): void {
		if (this.disposed || this.reconnectTimer !== null) return;
		const delay = Math.min(
			RECONNECT_BASE_MS * 2 ** this.reconnectAttempts,
			RECONNECT_MAX_MS,
		);
		this.reconnectAttempts++;
		this.reconnectTimer = window.setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, delay);
	}
}
