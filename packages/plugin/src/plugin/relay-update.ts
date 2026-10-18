import type { Plugin } from "obsidian";

import {
	accountRelays,
	ownRelayName,
	RELAY_VERSION,
	relayBehind,
} from "@/cloudflare";
import { cloudflareOf } from "@/settings/cloudflare-login";
import { testRelay } from "@/settings/connection-test";
import { runningRelayDeploy } from "@/settings/setup/relay";
import { reportWarning } from "@/shared";
import { openRelayUpdateModal } from "@/ui";

import type { PluginHost } from "./host";

const SKIPPED_KEY = "mdsync-relay-update-skipped";

/**
 * Offers to update an outdated relay once its socket connects, only where this device's Cloudflare token
 * can deploy it. Once per relay per launch; "not now" holds until a newer build ships.
 */
export function registerRelayUpdate(plugin: Plugin & PluginHost): void {
	const checked = new Set<string>();
	const check = async (): Promise<void> => {
		const { settings, app } = plugin;
		const login = cloudflareOf(settings);
		const { relayUrl, relaySecret } = settings;
		if (!login || checked.has(relayUrl) || runningRelayDeploy()) return;
		checked.add(relayUrl);
		if (app.loadLocalStorage(SKIPPED_KEY) === RELAY_VERSION) return;
		const status = await testRelay(settings);
		if (!status.ok || !relayBehind(status.version)) return;
		const relays = await accountRelays(login.api, login.accountId);
		const name = ownRelayName(relays, relayUrl);
		// Deploying a relay switched away from meanwhile would write it back over the new one.
		const stale =
			plugin.unloaded ||
			plugin.settings.relayUrl !== relayUrl ||
			plugin.settings.relaySecret !== relaySecret;
		if (!name || stale) return;
		const target = { name, secret: relaySecret };
		if (!(await openRelayUpdateModal(plugin, login, target))) {
			app.saveLocalStorage(SKIPPED_KEY, RELAY_VERSION);
		}
	};
	plugin.register(
		plugin.realtime.hub.listen({
			onConnectionChange: (connected) => {
				if (!connected) return;
				check().catch((err) =>
					reportWarning("Could not check the relay version.", err),
				);
			},
		}),
	);
}
