import { EFrame, OWNER, type ServerFrame } from "@mdsync/protocol";

import { deriveLiveKeys, type LiveKeys } from "@/crypto/live-keys";
import type { SpaceFrame, SpaceListener } from "@/hub/connection";
import { People, type PresenceAccess } from "@/presence/people";
import { type Space, VAULT_SPACE } from "@/sync/space";

/** Who the hub knows a socket as on a space's channel. */
export type Vouch = (space: string) => { who: string; name: string };

export interface Device {
	tag: number;
	people: People;
	listeners: Map<SpaceListener, string>;
	connected: boolean;
	vouch: Vouch;
	/** Replace it, as the records do, to change the partition. */
	spaces: readonly Space[];
}

/** The owner on every channel: the hub vouches for no one else. */
const OWNED: Vouch = () => ({ who: OWNER, name: "" });

/** Forwards channel awareness to every other device in the channel, as the hub does. */
export class Relay {
	private readonly devices: Device[] = [];

	add(
		spaces: readonly Space[],
		access: (space: Space) => Promise<PresenceAccess | null>,
		vouch = OWNED,
	): Device {
		const device: Device = {
			tag: this.devices.length + 1,
			listeners: new Map(),
			connected: false,
			people: null as unknown as People,
			vouch,
			spaces,
		};
		device.people = new People({
			hub: {
				space: (id) => ({
					send: (frame) => this.forward(device, id, frame),
					isConnected: () => device.connected,
					listen: (listener) => {
						device.listeners.set(listener, id);
						// A new channel is a new socket on the hub, which tells it who is here.
						if (device.connected) {
							queueMicrotask(() => this.tellWhoIsHere(device, listener, id));
						}
						return () => device.listeners.delete(listener);
					},
				}),
			},
			spaces: () => device.spaces,
			access,
		});
		device.people.refresh();
		this.devices.push(device);
		return device;
	}

	/** The newcomer hears who is here first, then everyone else hears it join. */
	join(device: Device): void {
		device.connected = true;
		for (const [listener, space] of device.listeners) {
			listener.onConnectionChange?.(true);
			this.tellWhoIsHere(device, listener, space);
		}
		this.toOthers(device, (space) => ({
			type: EFrame.Join,
			slot: 0,
			doc: "",
			from: device.tag,
			...device.vouch(space),
		}));
	}

	leave(device: Device): void {
		device.connected = false;
		for (const listener of device.listeners.keys()) {
			listener.onConnectionChange?.(false);
		}
		this.toOthers(device, () => ({
			type: EFrame.Leave,
			slot: 0,
			doc: "",
			from: device.tag,
		}));
	}

	private tellWhoIsHere(
		device: Device,
		listener: SpaceListener,
		space: string,
	): void {
		for (const other of this.devices) {
			if (other === device || !other.connected) continue;
			const here = { slot: 0, doc: "", from: other.tag, ...other.vouch(space) };
			listener.onFrame?.({ type: EFrame.Here, ...here });
		}
	}

	private forward(from: Device, space: string, frame: SpaceFrame): void {
		if (frame.type !== EFrame.Awareness) return;
		this.toOthers(
			from,
			() => ({
				type: EFrame.Peer,
				slot: 0,
				doc: "",
				from: from.tag,
				payload: frame.payload,
			}),
			space,
		);
	}

	private toOthers(
		from: Device,
		frame: (space: string) => ServerFrame,
		space?: string,
	): void {
		for (const device of this.devices) {
			if (device === from || !device.connected) continue;
			for (const [listener, id] of device.listeners) {
				if (space === undefined || id === space) listener.onFrame?.(frame(id));
			}
		}
	}
}

export const SHARE_ID = "s1";

export function keys(): Promise<LiveKeys> {
	return deriveLiveKeys(crypto.getRandomValues(new Uint8Array(32)));
}

export function spacesWith(root: string): Space[] {
	return [VAULT_SPACE, { id: SHARE_ID, root }];
}

export async function setup() {
	const vaultKeys = await keys();
	const shareKeys = await keys();
	const relay = new Relay();
	const accessFor =
		(device: string, person: string, name: string) => async (space: Space) =>
			space.id === SHARE_ID
				? { keys: shareKeys, key: person, name, device }
				: { keys: vaultKeys, key: device, name: device, device: null };
	return { relay, accessFor, vaultKeys, shareKeys };
}
