import type { PluginHost } from "@/plugin/host";
import { formatRelativeTime } from "@/shared/format";
import { shareIdentity } from "@/spaces/access";
import { type Space, spaceOf, VAULT_SPACE } from "@/sync/space";

/** "Changed by Alex, 5 minutes ago": people in a share, devices in the vault. */
export function lastEditLabel(plugin: PluginHost, path: string): string | null {
	const edit = plugin.controller.lastEdit(path);
	if (!edit) return null;
	const space = spaceOf(plugin.spaces.partition(), path);
	const vault = space.id === VAULT_SPACE.id;
	const mine = isMine(plugin, space, edit.key);
	const who = vault
		? `on ${mine ? "this device" : edit.name}`
		: `by ${mine ? "you" : edit.name}`;
	return `Changed ${who}, ${formatRelativeTime(edit.at)}`;
}

function isMine(plugin: PluginHost, space: Space, key: string): boolean {
	if (space.id === VAULT_SPACE.id) {
		return key === plugin.controller.currentDevice().id;
	}
	const record = plugin.settings.spaces.find(({ id }) => id === space.id);
	return record !== undefined && shareIdentity(record).person === key;
}
