/**
 * The vault's hub connection across settings changes: one HubLink at a time,
 * rebuilt when the channel or the credentials change, and listeners that
 * outlive the rebuilds (presence, the pull on signal, live documents).
 */

import {
	type ClientFrame,
	deriveChannelGrant,
	type ServerFrame,
} from "@obsync/protocol";

import { sha256Hex } from "@/crypto";
import {
	activeStorage,
	isRelayConfigured,
	isStorageConfigured,
	type ObsyncSettings,
} from "@/settings/model";
import { storageIdentity } from "@/storage";

import { type HubChannel, HubLink } from "./link";

/** The vault's channel is the link's only one until shares arrive. */
export const VAULT_SLOT = 0;

export interface HubListener {
	onFrame?(frame: ServerFrame): void;
	/** Also reported on every restart, so listeners drop state tied to the old link. */
	onConnectionChange?(connected: boolean): void;
}

export interface HubConnectionOptions {
	settings(): ObsyncSettings;
	deviceId(): string;
}

export class HubConnection {
	private link: HubLink | null = null;
	/** Everything the link depends on, so a change to any of it restarts. */
	private connectionKey: string | null = null;
	private connected = false;
	private disposed = false;
	private readonly listeners = new Set<HubListener>();

	constructor(private readonly options: HubConnectionOptions) {}

	isConnected(): boolean {
		return this.connected;
	}

	listen(listener: HubListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Dropped while the link is down: listeners re-send on reconnect. */
	send(frame: ClientFrame): void {
		this.link?.send(frame);
	}

	/** The cold-sync ping to the vault's other devices. */
	signal(): void {
		this.link?.signal(VAULT_SLOT);
	}

	/** Called after every settings save; an unchanged connection is left alone. */
	restartIfChanged(): void {
		const next = connectionKeyOf(this.options.settings());
		if (next === this.connectionKey && (this.link || next === null)) return;
		this.restart();
	}

	restart(): void {
		if (this.disposed) return;
		this.link?.dispose();
		this.link = null;
		this.setConnected(false);

		const settings = this.options.settings();
		this.connectionKey = connectionKeyOf(settings);
		if (this.connectionKey === null) return;
		this.link = new HubLink({
			serverUrl: settings.relayUrl,
			channels: vaultChannel(settings).then((channel) => [channel]),
			deviceId: this.options.deviceId(),
			onFrame: (frame) => {
				for (const listener of this.listeners) listener.onFrame?.(frame);
			},
			onConnectionChange: (connected) => this.setConnected(connected),
		});
		this.link.connect();
	}

	dispose(): void {
		this.disposed = true;
		this.link?.dispose();
		this.link = null;
		this.connectionKey = null;
		this.connected = false;
		this.listeners.clear();
	}

	private setConnected(connected: boolean): void {
		this.connected = connected;
		for (const listener of this.listeners) {
			listener.onConnectionChange?.(connected);
		}
	}
}

/** Hashed: the relay and its request logs never see the storage endpoint or bucket. */
async function vaultChannel(settings: ObsyncSettings): Promise<HubChannel> {
	const identity = storageIdentity(activeStorage(settings));
	const channel = await sha256Hex(new TextEncoder().encode(identity));
	return {
		channel,
		token: await deriveChannelGrant(settings.relaySecret, channel),
	};
}

/** Null when realtime cannot run at all with these settings. */
function connectionKeyOf(settings: ObsyncSettings): string | null {
	if (!settings.realtimeSync) return null;
	if (!isRelayConfigured(settings)) return null;
	if (!isStorageConfigured(settings)) return null;
	return [
		storageIdentity(activeStorage(settings)),
		settings.relayUrl,
		settings.relaySecret,
	].join("|");
}
