import type { PluginHost } from "@/app/host";
import { isLinkState, type LinkState } from "@/core/hub";
import { isAtNote, type Person } from "@/features/presence";
import { VAULT_SPACE } from "@/features/sync";

export interface CarriedSpace {
	id: string;
	status: LinkState;
}

export function carried(plugin: PluginHost): CarriedSpace[] {
	return plugin.spaces.partition().flatMap(({ id }) => {
		const status = plugin.realtime.hub.statusOf(id);
		return isLinkState(status) ? [{ id, status }] : [];
	});
}

export function inSharedNotes(plugin: PluginHost): Person[] {
	return carried(plugin)
		.filter(({ id }) => id !== VAULT_SPACE.id)
		.flatMap(({ id }) => plugin.realtime.people.online(id).filter(isAtNote));
}

export function spaceName(plugin: PluginHost, id: string): string {
	if (id === VAULT_SPACE.id) return "Vault";
	return plugin.spaces.get(id)?.name ?? id;
}
