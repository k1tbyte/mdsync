import type { ObsidianProtocolData } from "obsidian";
import { notifyError, notifyInfo } from "@/core/ui";
import type { StorageHost } from "../host";
import { handleStorageProtocol } from "../registry";

/** A backend's sign-in callback. A failure must be visible: it fires once and never retries. */
export async function authorizeStorage(
	plugin: StorageHost,
	params: ObsidianProtocolData,
	onAuthorized: () => void,
): Promise<void> {
	try {
		const outcome = await handleStorageProtocol(
			params,
			(kind) => plugin.settings.storageConfigs[kind],
			async () => {
				await plugin.saveSettings();
				onAuthorized();
			},
		);
		if (!outcome) return;
		if (outcome.ok) notifyInfo(outcome.message);
		else notifyError(outcome.message, outcome.detail);
	} catch (err) {
		notifyError("Storage authorization failed", err);
	}
}
