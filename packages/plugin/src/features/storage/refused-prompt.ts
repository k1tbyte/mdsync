import type { StorageHost } from "./host";
import { activeStorage } from "./settings";
import { openStorageRefusedModal } from "./ui/storage-refused-modal";

/** Drive replaces its access token hourly; the keys are what the person set. */
const VOLATILE = new Set(["accessToken", "expiresAt"]);

/** Asks once per set of keys: every sync run hits the same refusal until they change, here or in the settings. */
export function createStorageRefusedPrompt(plugin: StorageHost): () => void {
	let askedFor: string | null = null;
	return () => {
		const keys = JSON.stringify(
			activeStorage(plugin.settings),
			(key, value: unknown) => (VOLATILE.has(key) ? undefined : value),
		);
		if (keys === askedFor) return;
		askedFor = keys;
		void openStorageRefusedModal(plugin);
	};
}
