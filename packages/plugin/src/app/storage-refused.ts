import { createStorageRefusedPrompt } from "@/features/storage";
import { type Space, VAULT_SPACE } from "@/features/sync";
import type { PluginHost } from "./host";

/** The vault and owned shares reach the storage with this device's keys; a participant's are the owner's to fix. */
export function createStorageRefused(
	plugin: PluginHost,
): (space: Space) => void {
	const ask = createStorageRefusedPrompt(plugin);
	return (space) => {
		const own =
			space.root === VAULT_SPACE.root ||
			plugin.spaces.get(space.id)?.access.kind === "owner";
		if (own) ask();
	};
}
