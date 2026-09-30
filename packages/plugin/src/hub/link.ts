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
	KEEPALIVE_INTERVAL_MS,
	KEEPALIVE_PING,
	KEEPALIVE_SILENCE_MS,
	type ServerFrame,
	UNAUTHORIZED_CLOSE_CODE,
} from "@obsync/protocol";
import { requestUrl } from "obsidian";

import type { LinkState } from "./status";

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
/** A fresh share token can be refused for about a minute while the relay's KV catches up. */
const UNAUTHORIZED_RETRIES = 6;

export interface HubChannel {
	channel: string;
	/** Channel grant derived from the relay secret, or a share token. */
	token: string;
}

export interface HubLinkOptions {
	/** With no trailing slash, as `hubRoutes` gives it. */
	serverUrl: string;
	/** In slot order; asked per connection, since owner grants expire. */
	channels(): Promise<readonly HubChannel[]>;
	/** Opaque; lets an HTTP signal skip this device's own socket. */
	deviceId: string;
	onFrame(frame: ServerFrame): void;
	onConnectionChange?(connected: boolean): void;
}

export class HubLink {
	private ws: WebSocket | null = null;
	private status: LinkState = "connecting";
	private reconnectAttempts = 0;
	private unauthorizedCloses = 0;
	private reconnectTimer: number | null = null;
	private pingTimer: number | null = null;
	private opening = false;
	private wake: AbortController | null = null;
	private disposed = false;
	private lastMessageAt = 0;

	constructor(private readonly options: HubLinkOptions) {}

	/** `unauthorized` once the relay kept refusing the link. */
	get state(): LinkState {
		return this.status;
	}

	get connected(): boolean {
		return this.ws?.readyState === WebSocket.OPEN;
	}

	private get connecting(): boolean {
		return this.opening || this.ws?.readyState === WebSocket.CONNECTING;
	}

	connect(): void {
		this.watchWake();
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
		this.wake?.abort();
		this.cleanup();
	}

	private async openSocket(): Promise<void> {
		// One open at a time: a backoff firing mid-open would kill the socket it makes.
		if (this.disposed || this.opening) return;

		let socket: WebSocket;
		this.opening = true;
		this.stopReconnect();
		try {
			const base = this.options.serverUrl.replace(/^http(s)?:/, "ws$1:");
			const url = await this.hubUrl(base);
			if (this.disposed) return;
			this.cleanup();
			socket = new WebSocket(url);
		} catch {
			// A malformed server URL cannot be fixed by retrying.
			this.status = "offline";
			this.options.onConnectionChange?.(false);
			return;
		} finally {
			this.opening = false;
		}
		socket.binaryType = "arraybuffer";
		this.ws = socket;

		socket.addEventListener("open", () => {
			if (this.ws !== socket) return;
			this.lastMessageAt = Date.now();
			this.status = "connected";
			this.startPing();
			this.options.onConnectionChange?.(true);
		});
		socket.addEventListener("message", (event) => {
			if (this.ws !== socket) return;
			this.lastMessageAt = Date.now();
			this.reconnectAttempts = 0;
			this.unauthorizedCloses = 0;
			// Text is only the keepalive's answer.
			if (!(event.data instanceof ArrayBuffer)) return;
			const frame = decodeServer(new Uint8Array(event.data));
			if (frame) this.options.onFrame(frame);
		});
		socket.addEventListener("close", (event) => {
			if (this.ws !== socket) return;
			this.lose(
				event.code === UNAUTHORIZED_CLOSE_CODE &&
					++this.unauthorizedCloses > UNAUTHORIZED_RETRIES,
			);
		});
		socket.addEventListener("error", () => socket.close());
	}

	/** Down from now, whenever its close event comes: reconnects unless the relay refused it for good. */
	private lose(refused = false): void {
		this.cleanup();
		this.status = refused ? "unauthorized" : "offline";
		this.options.onConnectionChange?.(false);
		if (!refused) this.scheduleReconnect();
	}

	/** After sleep or a network change the backoff may have grown long: try again at once. */
	private watchWake(): void {
		if (this.wake) return;
		this.wake = new AbortController();
		const { signal } = this.wake;
		const retry = (): void => {
			if (!this.connected && !this.connecting) void this.openSocket();
		};
		window.addEventListener("online", retry, { signal });
		document.addEventListener(
			"visibilitychange",
			() => {
				if (document.visibilityState === "visible") retry();
			},
			{ signal },
		);
	}

	private async signalOverHttp(slot: number): Promise<void> {
		try {
			const channel = (await this.options.channels())[slot];
			if (!channel) return;
			const url = new URL(`${this.options.serverUrl}${HUB_SIGNAL_PATH}`);
			url.searchParams.set(EHubParam.Channel, channel.channel);
			url.searchParams.set(EHubParam.Token, channel.token);
			url.searchParams.set(EHubParam.Device, this.options.deviceId);
			await requestUrl({ url: url.toString(), method: "POST", throw: false });
		} catch {
			// Best effort: a missed signal only delays the next pull.
		}
	}

	private async hubUrl(base: string): Promise<string> {
		const url = new URL(`${base}${HUB_PATH}`);
		for (const { channel, token } of await this.options.channels()) {
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
			// A silently dead link may take long to report its close: give up on it now.
			if (Date.now() - this.lastMessageAt > KEEPALIVE_SILENCE_MS) {
				this.lose();
				return;
			}
			this.ws.send(KEEPALIVE_PING);
		}, KEEPALIVE_INTERVAL_MS);
	}

	private stopPing(): void {
		if (this.pingTimer === null) return;
		window.clearInterval(this.pingTimer);
		this.pingTimer = null;
	}

	private stopReconnect(): void {
		if (this.reconnectTimer === null) return;
		window.clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
	}

	private cleanup(): void {
		this.stopPing();
		// A pending reconnect belongs to the socket being replaced.
		this.stopReconnect();
		const socket = this.ws;
		this.ws = null;
		try {
			socket?.close();
		} catch {}
	}

	private scheduleReconnect(): void {
		if (this.disposed || this.reconnectTimer !== null) return;
		const ceiling = Math.min(
			RECONNECT_BASE_MS * 2 ** this.reconnectAttempts,
			RECONNECT_MAX_MS,
		);
		// Devices cut off by one relay restart would otherwise return in lockstep.
		const delay = (ceiling / 2) * (1 + Math.random());
		this.reconnectAttempts++;
		this.reconnectTimer = window.setTimeout(() => {
			this.reconnectTimer = null;
			void this.openSocket();
		}, delay);
	}
}
