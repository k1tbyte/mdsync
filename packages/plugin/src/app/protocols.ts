import type { ObsidianProtocolData, Plugin } from "obsidian";

import { LINK_PARAM } from "@/core/crypto";
import { notifyError, notifyInfo } from "@/core/ui";
import { INVITE_ACTION, openInvite } from "@/features/spaces";
import { handleStorageProtocol } from "@/features/storage";
import { TRANSFER_ACTION } from "@/features/transfer";

import type { PluginHost } from "./host";

/** obsidian:// entry points owned by the plugin itself. */
export function registerProtocolHandlers(
	plugin: Plugin & PluginHost,
	onStorageAuthorized: () => void,
): void {
	plugin.registerObsidianProtocolHandler(TRANSFER_ACTION, (params) => {
		void plugin.transfer.handleProtocol(params);
	});
	plugin.registerObsidianProtocolHandler("mdsync-auth", (params) => {
		void authorizeStorage(plugin, params, onStorageAuthorized);
	});
	plugin.registerObsidianProtocolHandler(INVITE_ACTION, (params) => {
		void openInvite(plugin, params[LINK_PARAM] ?? "");
	});
}

/** A failure here must be visible: the callback fires once and never retries. */
async function authorizeStorage(
	plugin: PluginHost,
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
