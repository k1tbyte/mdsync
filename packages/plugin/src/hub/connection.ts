/**
 * This device's hub sockets across settings changes: one HubLink per relay,
 * rebuilt when its channels or credentials change, and listeners that outlive
 * the rebuilds (presence, the pull on signal, live documents).
 */

import { type ClientFrame, EFrame, type ServerFrame } from "@obsync/protocol";

import type { ObsyncSettings } from "@/settings/model";
import { VAULT_SPACE } from "@/sync/space";

import { type HubRoute, hubRoutes } from "./channels";
import { HubLink } from "./link";

/** The relay's own state and the cold-sync ping; frames go to `SpaceListener`s. */
export interface HubListener {
	/** Another device pushed into any space this device holds. */
	onSignal?(): void;
	/** The vault's socket; also reported on every restart, so listeners drop state tied to the old link. */
	onConnectionChange?(connected: boolean): void;
}

/** One space's channel: its frames, and whether its socket carries it right now. */
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

interface OpenLink {
	route: HubRoute;
	link: HubLink;
	connected: boolean;
	/** Slots the relay refused or cut; the socket goes on for the rest. */
	revoked: Set<number>;
}

export class HubConnection {
	/** By relay URL. */
	private readonly links = new Map<string, OpenLink>();
	private disposed = false;
	private readonly listeners = new Set<HubListener>();
	private readonly spaceListeners = new Map<SpaceListener, string>();

	constructor(private readonly options: HubConnectionOptions) {}

	/** The vault's socket: what the relay status shows. */
	isConnected(): boolean {
		return this.spaceConnected(VAULT_SPACE.id);
	}

	listen(listener: HubListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	space(id: string): SpaceHub {
		return {
			send: (frame) => {
				const at = this.slotOf(id);
				at?.open.link.send({ ...frame, slot: at.slot } as ClientFrame);
			},
			isConnected: () => this.spaceConnected(id),
			listen: (listener) => {
				this.spaceListeners.set(listener, id);
				return () => this.spaceListeners.delete(listener);
			},
		};
	}

	/** The cold-sync ping to every other device holding the space. */
	signal(spaceId: string): void {
		const at = this.slotOf(spaceId);
		at?.open.link.signal(at.slot);
	}

	/** Called after every settings save; unchanged sockets are left alone. */
	restartIfChanged(): void {
		this.update(false);
	}

	restart(): void {
		this.update(true);
	}

	dispose(): void {
		this.disposed = true;
		for (const { link } of this.links.values()) link.dispose();
		this.links.clear();
		this.listeners.clear();
		this.spaceListeners.clear();
	}

	private update(force: boolean): void {
		if (this.disposed) return;
		const routes = new Map(
			hubRoutes(this.options.settings()).map((route) => [
				route.serverUrl,
				route,
			]),
		);
		for (const [url, open] of this.links) {
			if (!force && routes.get(url)?.key === open.route.key) {
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
			connected: false,
			revoked: new Set(),
			link: new HubLink({
				serverUrl: route.serverUrl,
				channels: route.channels(),
				deviceId: this.options.deviceId(),
				onFrame: (frame) => this.onFrame(open, frame),
				onConnectionChange: (connected) => this.setConnected(open, connected),
			}),
		};
		this.links.set(route.serverUrl, open);
		open.link.connect();
	}

	private onFrame(open: OpenLink, frame: ServerFrame): void {
		if (frame.type === EFrame.Signal) {
			for (const listener of this.listeners) listener.onSignal?.();
			return;
		}
		const space = open.route.spaces[frame.slot];
		if (space === undefined) return;
		if (frame.type === EFrame.Revoked) {
			open.revoked.add(frame.slot);
			this.tell(space, (listener) => listener.onConnectionChange?.(false));
			if (space === VAULT_SPACE.id) this.tellVault(false);
			return;
		}
		this.tell(space, (listener) => listener.onFrame?.(frame));
	}

	/** Every space of the socket hears it, the vault's listeners too when it leads. */
	private setConnected(open: OpenLink, connected: boolean): void {
		open.connected = connected;
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
		const at = this.slotOf(space);
		return at?.open.connected === true && !at.open.revoked.has(at.slot);
	}
}
