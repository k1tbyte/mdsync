/**
 * This device's hub sockets across settings changes: one HubLink per relay, rebuilt when its channels or
 * credentials change; listeners outlive the rebuilds.
 */

import { type ClientFrame, EFrame, type ServerFrame } from "@obsync/protocol";

import type { ObsyncSettings } from "@/settings/model";
import { pauseOf } from "@/spaces";
import { VAULT_SPACE } from "@/sync/space";

import { type HubRoute, hubRoutes } from "./channels";
import { HubLink } from "./link";
import { type RelayStatus, relayStatus } from "./status";

/** The relay's own state and the cold-sync ping; frames go to `SpaceListener`s. */
export interface HubListener {
	/** Another device pushed into any space this device holds. */
	onSignal?(spaceId: string): void;
	/** The relay cut a space's grant: revoked, or a token too new for it yet. */
	onRevoked?(): void;
	/** The vault's socket; also reported on every restart, so listeners drop state tied to the old link. */
	onConnectionChange?(connected: boolean): void;
}

export interface SpaceListener {
	onFrame?(frame: ServerFrame): void;
	/** False on every restart of its socket and when the relay revokes the channel. */
	onConnectionChange?(connected: boolean): void;
}

/** A client frame before its socket's slot is known. */
export type SpaceFrame = ClientFrame extends infer F
	? F extends ClientFrame
		? Omit<F, "slot">
		: never
	: never;

/** A space's channel on whichever socket holds it; frames sent while it is down are dropped. */
export interface SpaceHub {
	send(frame: SpaceFrame): void;
	isConnected(): boolean;
	listen(listener: SpaceListener): () => void;
}

export interface HubConnectionOptions {
	settings(): ObsyncSettings;
	deviceId(): string;
}

const REVOKED_RETRY_MS = 15_000;
const REVOKED_RETRIES = 3;

interface OpenLink {
	route: HubRoute;
	link: HubLink;
	/** Slots the relay refused or cut; the socket goes on for the rest. */
	revoked: Set<number>;
}

export class HubConnection {
	private readonly links = new Map<string, OpenLink>();
	private disposed = false;
	private readonly listeners = new Set<HubListener>();
	private readonly spaceListeners = new Map<SpaceListener, string>();
	private readonly revokedRetries = new Map<string, number>();
	private readonly retryTimers = new Set<number>();

	constructor(private readonly options: HubConnectionOptions) {}

	/** The vault's socket: what the relay status shows. */
	isConnected(): boolean {
		return this.spaceConnected(VAULT_SPACE.id);
	}

	/** The one answer to what the relay is doing for a space; every status display reads it. */
	statusOf(spaceId: string): RelayStatus {
		const settings = this.options.settings();
		const record = settings.spaces.find(({ id }) => id === spaceId);
		const at = this.slotOf(spaceId);
		return relayStatus({
			realtime: settings.realtimeSync,
			paused: record !== undefined && pauseOf(record, settings) !== null,
			link: at?.open.link.state ?? null,
			revoked: at?.open.revoked.has(at.slot) ?? false,
			full: [...this.links.values()].some(({ route }) =>
				route.full.includes(spaceId),
			),
		});
	}

	listen(listener: HubListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	space(id: string): SpaceHub {
		return {
			send: (frame) => {
				const at = this.slotOf(id);
				at?.open.link.send({ ...frame, slot: at.slot });
			},
			isConnected: () => this.spaceConnected(id),
			listen: (listener) => {
				this.spaceListeners.set(listener, id);
				return () => this.spaceListeners.delete(listener);
			},
		};
	}

	signal(spaceId: string): void {
		const at = this.slotOf(spaceId);
		at?.open.link.signal(at.slot);
	}

	/** Called after every settings save; unchanged sockets are left alone. */
	restartIfChanged(): void {
		this.revokedRetries.clear();
		this.update(() => false);
	}

	restart(): void {
		this.revokedRetries.clear();
		this.update(() => true);
	}

	/** Restarts only the socket carrying the space: other relays' rooms stay joined. */
	reconnect(spaceId: string): void {
		const url = this.slotOf(spaceId)?.open.route.serverUrl;
		this.update((at) => at === url);
	}

	dispose(): void {
		this.disposed = true;
		for (const timer of this.retryTimers) window.clearTimeout(timer);
		this.retryTimers.clear();
		for (const { link } of this.links.values()) link.dispose();
		this.links.clear();
		this.listeners.clear();
		this.spaceListeners.clear();
	}

	private update(force: (url: string) => boolean): void {
		if (this.disposed) return;
		const routes = new Map(
			hubRoutes(this.options.settings()).map((route) => [
				route.serverUrl,
				route,
			]),
		);
		for (const [url, open] of this.links) {
			const route = routes.get(url);
			if (!force(url) && route?.key === open.route.key) {
				// The key leaves out the spaces past the slots: they may have changed.
				open.route = route;
				routes.delete(url);
				continue;
			}
			open.link.dispose();
			this.links.delete(url);
			this.setConnected(open, false);
		}
		for (const route of routes.values()) this.open(route);
	}

	private open(route: HubRoute): void {
		const open: OpenLink = {
			route,
			revoked: new Set(),
			link: new HubLink({
				serverUrl: route.serverUrl,
				channels: route.channels,
				deviceId: this.options.deviceId(),
				onFrame: (frame) => this.onFrame(open, frame),
				onConnectionChange: (connected) => this.setConnected(open, connected),
			}),
		};
		this.links.set(route.serverUrl, open);
		open.link.connect();
	}

	private onFrame(open: OpenLink, frame: ServerFrame): void {
		const space = open.route.spaces[frame.slot];
		if (space === undefined) return;
		if (frame.type === EFrame.Signal) {
			if (open.revoked.has(frame.slot)) return;
			for (const listener of this.listeners) listener.onSignal?.(space);
			return;
		}
		if (frame.type === EFrame.Revoked) {
			open.revoked.add(frame.slot);
			for (const listener of this.listeners) listener.onRevoked?.();
			this.tell(space, (listener) => listener.onConnectionChange?.(false));
			if (space === VAULT_SPACE.id) this.tellVault(false);
			this.retryRevoked(space);
			return;
		}
		this.revokedRetries.delete(space);
		this.tell(space, (listener) => listener.onFrame?.(frame));
	}

	private retryRevoked(space: string): void {
		const attempts = this.revokedRetries.get(space) ?? 0;
		if (attempts >= REVOKED_RETRIES) return;
		this.revokedRetries.set(space, attempts + 1);
		const delay = REVOKED_RETRY_MS * 2 ** attempts * (0.5 + Math.random());
		const timer = window.setTimeout(() => {
			this.retryTimers.delete(timer);
			if (this.statusOf(space) === "unauthorized") this.reconnect(space);
		}, delay);
		this.retryTimers.add(timer);
	}

	/** Every space of the socket hears it, the vault's listeners too when it leads. */
	private setConnected(open: OpenLink, connected: boolean): void {
		// A new socket is admitted afresh: whatever is still refused says so again.
		open.revoked.clear();
		for (const space of open.route.spaces) {
			this.tell(space, (listener) => listener.onConnectionChange?.(connected));
		}
		if (open.route.spaces.includes(VAULT_SPACE.id)) this.tellVault(connected);
	}

	private tell(space: string, act: (listener: SpaceListener) => void): void {
		for (const [listener, id] of this.spaceListeners) {
			if (id === space) act(listener);
		}
	}

	private tellVault(connected: boolean): void {
		for (const listener of this.listeners) {
			listener.onConnectionChange?.(connected);
		}
	}

	private slotOf(space: string): { open: OpenLink; slot: number } | null {
		for (const open of this.links.values()) {
			const slot = open.route.spaces.indexOf(space);
			if (slot !== -1) return { open, slot };
		}
		return null;
	}

	private spaceConnected(space: string): boolean {
		return this.statusOf(space) === "connected";
	}
}
