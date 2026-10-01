/**
 * Which relays this device holds a socket to and the channels on each: its own
 * relay for the vault and the shares it owns, each owner's relay for the shares
 * it joined. One socket per relay, however many channels it carries.
 */

import { deriveChannelGrant, MAX_SLOTS, shareChannel } from "@obsync/protocol";

import { sha256Hex } from "@/crypto";
import {
	activeStorage,
	isRelayConfigured,
	isStorageConfigured,
	type ObsyncSettings,
} from "@/settings/model";
import { relayBase } from "@/shared/path";
import { pauseOf } from "@/spaces";
import type { SpaceRecord } from "@/spaces/record";
import { storageIdentity } from "@/storage";
import { VAULT_SPACE } from "@/sync/space";

import type { HubChannel } from "./link";

export interface HubRoute {
	serverUrl: string;
	/** Everything the socket depends on: a change reconnects it. */
	key: string;
	/** Space ids in slot order; the vault, where present, is slot 0. */
	spaces: readonly string[];
	/** Past the hub's slots: not carried, rather than waiting forever. */
	full: readonly string[];
	channels(): Promise<HubChannel[]>;
}

interface Slot {
	space: string;
	key: string;
	channel(): Promise<HubChannel>;
}

export function hubRoutes(settings: ObsyncSettings): HubRoute[] {
	if (!settings.realtimeSync) return [];
	const routes = new Map<string, { slots: Slot[]; full: string[] }>();
	const add = (url: string, slot: Slot) => {
		const serverUrl = relayBase(url);
		const route = routes.get(serverUrl) ?? { slots: [], full: [] };
		if (route.slots.length < MAX_SLOTS) route.slots.push(slot);
		else route.full.push(slot.space);
		routes.set(serverUrl, route);
	};
	if (isRelayConfigured(settings) && isStorageConfigured(settings)) {
		const { relayUrl, relaySecret } = settings;
		const identity = storageIdentity(activeStorage(settings));
		add(relayUrl, {
			space: VAULT_SPACE.id,
			key: `${identity}|${relaySecret}`,
			channel: () => vaultChannel(identity, relaySecret),
		});
		for (const { id, access } of openRecords(settings)) {
			if (access.kind !== "owner") continue;
			add(relayUrl, {
				space: id,
				key: relaySecret,
				channel: () => granted(shareChannel(id), relaySecret),
			});
		}
	}
	for (const { id, access } of openRecords(settings)) {
		if (access.kind !== "participant") continue;
		add(access.relayUrl, {
			space: id,
			key: access.token,
			channel: async () => ({ channel: shareChannel(id), token: access.token }),
		});
	}
	return [...routes].map(([serverUrl, { slots, full }]) => ({
		serverUrl,
		key: JSON.stringify(slots.map(({ space, key }) => [space, key])),
		spaces: slots.map((slot) => slot.space),
		full,
		channels: () => Promise.all(slots.map((slot) => slot.channel())),
	}));
}

/** A paused share is not synced here, so nothing signals it either. */
function openRecords(settings: ObsyncSettings): SpaceRecord[] {
	return settings.spaces.filter(
		(record) => !record.closed && pauseOf(record, settings) === null,
	);
}

/** Hashed: the relay and its request logs never see the storage endpoint or bucket. */
async function vaultChannel(
	identity: string,
	secret: string,
): Promise<HubChannel> {
	const channel = await sha256Hex(new TextEncoder().encode(identity));
	return granted(channel, secret);
}

async function granted(channel: string, secret: string): Promise<HubChannel> {
	return { channel, token: await deriveChannelGrant(secret, channel) };
}
