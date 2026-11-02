import { isConnected, isLinkState, type LinkState } from "@/core/hub";
import { isRelayConfigured } from "@/core/settings";
import { relayBase } from "@/core/shared";
import { isAtNote, type Person } from "@/features/presence";
import { VAULT_SPACE } from "@/features/sync";
import type { StatusHost } from "./host";

export interface CarriedSpace {
	id: string;
	status: LinkState;
}

/** One socket and the spaces riding it: several shared folders on one relay share it. */
export interface RelayGroup {
	/** "Your relay", or the host of the relay a share was joined through. */
	name: string;
	state: LinkState;
	spaces: CarriedSpace[];
	/** On this relay, but past its slots. */
	full: string[];
}

export function carried(plugin: StatusHost): CarriedSpace[] {
	return plugin.spaces.partition().flatMap(({ id }) => {
		const status = plugin.realtime.hub.statusOf(id);
		return isLinkState(status) ? [{ id, status }] : [];
	});
}

/** The carried spaces by the socket that carries them, this device's own relay first. */
export function relayGroups(plugin: StatusHost): RelayGroup[] {
	const shown = new Set(plugin.spaces.partition().map(({ id }) => id));
	const all = carried(plugin);
	const { settings } = plugin;
	const own = isRelayConfigured(settings) ? relayBase(settings.relayUrl) : null;
	return plugin.realtime.hub
		.relays()
		.flatMap(({ url, state, spaces, full }) => {
			const riding = all.filter(({ id }) => spaces.includes(id));
			const left = full.filter((id) => shown.has(id));
			if (riding.length === 0 && left.length === 0) return [];
			const name = url === own ? "Your relay" : hostOf(url);
			return [{ name, state, spaces: riding, full: left }];
		});
}

/** Only a connected shared folder shows who is in it; without one, "nobody" would be a guess. */
export function sharesConnected(spaces: readonly CarriedSpace[]): boolean {
	return spaces.some(
		({ id, status }) => id !== VAULT_SPACE.id && isConnected(status),
	);
}

export function inSharedNotes(plugin: StatusHost): Person[] {
	return carried(plugin)
		.filter(({ id }) => id !== VAULT_SPACE.id)
		.flatMap(({ id }) => plugin.realtime.people.online(id).filter(isAtNote));
}

export function spaceName(plugin: StatusHost, id: string): string {
	if (id === VAULT_SPACE.id) return "Vault";
	return plugin.spaces.get(id)?.name ?? id;
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}
