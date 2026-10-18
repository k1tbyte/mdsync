import type { PluginHost } from "@/plugin/host";
import { activeStorage } from "@/settings/model";
import { type Space, VAULT_SPACE } from "@/sync/space";
import { openStorageRefusedModal } from "@/ui";

const VOLATILE = new Set(["accessToken", "expiresAt"]);

/**
 * The vault and owned shares reach the storage with this device's keys; a participant's are the owner's to fix.
 * Asks once per set of keys: every sync run hits the same refusal until they change, here or in the settings.
 */
export function createStorageRefused(
	plugin: PluginHost,
): (space: Space) => void {
	let askedFor: string | null = null;
	return (space) => {
		const own =
			space.root === VAULT_SPACE.root ||
			plugin.spaces.get(space.id)?.access.kind === "owner";
		const keys = JSON.stringify(activeStorage(plugin.settings), (key, value) =>
			// Drive replaces its access token hourly; the keys are what the person set.
			VOLATILE.has(key) ? undefined : value,
		);
		if (!own || keys === askedFor) return;
		askedFor = keys;
		void openStorageRefusedModal(plugin);
	};
}
