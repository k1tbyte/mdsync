import type { Plugin } from "obsidian";

import type { SyncController, SyncStatusSnapshot } from "@/sync/controller";
import { confirmAdoptNewVault, notifyError, notifyInfo } from "@/ui";

const VAULT_MISMATCH_ERROR = "Remote vault id does not match local";

/**
 * Offers to adopt the remote vault when its id stopped matching ours, usually because another device reset
 * the storage.
 */
export function registerVaultAdoptionPrompt(
	plugin: Plugin,
	controller: SyncController,
): void {
	/** Only the modal's own answer frees it: a broadcast without the error meanwhile would open a second one. */
	let active = false;

	const maybePrompt = async (snapshot: SyncStatusSnapshot): Promise<void> => {
		if (active || !(snapshot.error?.includes(VAULT_MISMATCH_ERROR) ?? false)) {
			return;
		}
		active = true;
		try {
			if (!(await confirmAdoptNewVault(plugin.app))) return;
			await controller.adoptNewVault();
			notifyInfo("Adopted new remote vault.");
		} catch (err) {
			notifyError("Operation failed", err);
		} finally {
			// Declining must not silence the prompt until the next reload.
			active = false;
		}
	};

	plugin.register(
		controller.subscribe((snapshot) => {
			void maybePrompt(snapshot);
		}),
	);
}
