/**
 * Who else holds a hub channel, built from the devices' own announcements: the
 * hub only relays them, tagged with the socket that sent each one.
 */

import { CHANNEL_DOC, EFrame, type ServerFrame } from "@obsync/protocol";

import { type HubConnection, type HubListener, VAULT_SLOT } from "./connection";

export interface PresenceDevice {
	id: string;
	name: string;
}

/** Announcements come from other devices, so their fields are capped here. */
const MAX_FIELD_LENGTH = 64;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The vault channel's other devices, as the settings tab shows them. */
export class DevicePresence implements HubListener {
	private channel: ChannelPresence | null = null;
	private devices: readonly PresenceDevice[] = [];
	private readonly listeners = new Set<
		(devices: readonly PresenceDevice[]) => void
	>();

	constructor(
		private readonly hub: Pick<HubConnection, "send">,
		/** Read per connection, so a rename is announced after the restart it causes. */
		private readonly self: () => PresenceDevice,
	) {}

	getDevices(): readonly PresenceDevice[] {
		return this.devices;
	}

	subscribe(
		listener: (devices: readonly PresenceDevice[]) => void,
	): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onConnectionChange(connected: boolean): void {
		this.channel = connected ? new ChannelPresence(this.self()) : null;
		if (connected) this.announce();
		else this.emit([]);
	}

	onFrame(frame: ServerFrame): void {
		if (frame.slot !== VAULT_SLOT || frame.doc !== CHANNEL_DOC) return;
		// Presence is never stored, so every newcomer is told who is here.
		if (frame.type === EFrame.Join) {
			this.announce();
			return;
		}
		if (this.channel?.apply(frame)) this.emit(this.channel.devices());
	}

	private announce(): void {
		if (!this.channel) return;
		this.hub.send({
			type: EFrame.Awareness,
			slot: VAULT_SLOT,
			doc: CHANNEL_DOC,
			payload: this.channel.announcement(),
		});
	}

	private emit(devices: readonly PresenceDevice[]): void {
		if (sameDevices(this.devices, devices)) return;
		this.devices = devices;
		for (const listener of this.listeners) listener(devices);
	}
}

export class ChannelPresence {
	private readonly bySocket = new Map<number, PresenceDevice>();

	constructor(private readonly self: PresenceDevice) {}

	/** This device's announcement, sent on connect and to every newcomer. */
	announcement(): Uint8Array {
		return encoder.encode(JSON.stringify(this.self));
	}

	/** False when the frame is not presence or carries a malformed announcement. */
	apply(frame: ServerFrame): boolean {
		if (frame.type === EFrame.Leave) return this.bySocket.delete(frame.from);
		if (frame.type !== EFrame.Peer) return false;
		const device = deviceOf(frame.payload);
		if (!device) return false;
		this.bySocket.set(frame.from, device);
		return true;
	}

	clear(): void {
		this.bySocket.clear();
	}

	/** Other devices, one entry per device even when it holds several sockets. */
	devices(): PresenceDevice[] {
		const byId = new Map<string, PresenceDevice>();
		for (const device of this.bySocket.values()) {
			if (device.id !== this.self.id) byId.set(device.id, device);
		}
		return [...byId.values()].sort(
			(left, right) =>
				left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
		);
	}
}

function deviceOf(payload: Uint8Array): PresenceDevice | null {
	let value: unknown;
	try {
		value = JSON.parse(decoder.decode(payload));
	} catch {
		return null;
	}
	if (!value || typeof value !== "object") return null;
	const { id, name } = value as { id?: unknown; name?: unknown };
	if (typeof id !== "string" || typeof name !== "string") return null;
	const device = { id: clamp(id), name: clamp(name) };
	return device.id && device.name ? device : null;
}

function clamp(field: string): string {
	return field.trim().slice(0, MAX_FIELD_LENGTH);
}

function sameDevices(
	current: readonly PresenceDevice[],
	next: readonly PresenceDevice[],
): boolean {
	if (current.length !== next.length) return false;
	return current.every(
		(device, index) =>
			device.id === next[index]?.id && device.name === next[index]?.name,
	);
}
