import type { PluginHost } from "@/plugin/host";
import { formatRelativeTime } from "@/shared";
import { shareIdentity } from "@/spaces/record";
import { type Space, spaceOf, VAULT_SPACE } from "@/sync/space";

/** "Changed by Alex, 5 minutes ago": people in a share, devices in the vault. */
export function lastEditLabel(plugin: PluginHost, path: string): string | null {
	const edit = plugin.controller.lastEdit(path);
	return edit
		? `Changed ${editorOf(plugin, path, edit.key, edit.name)}, ${formatRelativeTime(edit.at)}`
		: null;
}

/** "on Laptop" in the vault, "by Alex" in a share. */
export function lastEditor(plugin: PluginHost, path: string): string | null {
	const edit = plugin.controller.lastEdit(path);
	return edit ? editorOf(plugin, path, edit.key, edit.name) : null;
}

function editorOf(
	plugin: PluginHost,
	path: string,
	key: string,
	name: string,
): string {
	const space = spaceOf(plugin.spaces.partition(), path);
	const mine = isMine(plugin, space, key);
	return space.id === VAULT_SPACE.id
		? `on ${mine ? "this device" : name}`
		: `by ${mine ? "you" : name}`;
}

function isMine(plugin: PluginHost, space: Space, key: string): boolean {
	if (space.id === VAULT_SPACE.id) {
		return key === plugin.controller.currentDevice().id;
	}
	const record = plugin.spaces.get(space.id);
	return record !== undefined && shareIdentity(record).person === key;
}
