import { isLinkState, type LinkState } from "@/hub/status";
import type { PluginHost } from "@/plugin/host";
import type { Person } from "@/presence/people";
import { VAULT_SPACE } from "@/sync/space";

export function carried(
	plugin: PluginHost,
): { id: string; status: LinkState }[] {
	return plugin.spaces.partition().flatMap(({ id }) => {
		const status = plugin.realtime.statusOf(id);
		return isLinkState(status) ? [{ id, status }] : [];
	});
}

export function isConnected(status: LinkState): boolean {
	return status === "connected";
}

export function inSharedNotes(plugin: PluginHost): Person[] {
	const byKey = new Map<string, Person>();
	for (const { id } of carried(plugin)) {
		if (id === VAULT_SPACE.id) continue;
		for (const person of plugin.realtime.people.online(id)) {
			if (person.note !== null && !person.idle) {
				byKey.set(`${id}|${person.key}`, person);
			}
		}
	}
	return [...byKey.values()];
}

export function spaceName(plugin: PluginHost, id: string): string {
	if (id === VAULT_SPACE.id) return "Vault";
	return plugin.settings.spaces.find((record) => record.id === id)?.name ?? id;
}
