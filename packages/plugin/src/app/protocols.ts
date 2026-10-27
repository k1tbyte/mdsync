import type { Plugin } from "obsidian";

import { LINK_PARAM } from "@/core/crypto";
import { INVITE_ACTION, openInvite } from "@/features/spaces";
import { authorizeStorage } from "@/features/storage";
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
