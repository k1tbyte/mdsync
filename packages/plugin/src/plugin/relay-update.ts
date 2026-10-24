import type { Plugin } from "obsidian";

import {
	accountRelays,
	ownRelayName,
	RELAY_VERSION,
	type RelayTarget,
	relayBehind,
} from "@/cloudflare";
import { cloudflareOf } from "@/settings/cloudflare-login";
import { testRelay } from "@/settings/connection-test";
import { runningRelayDeploy } from "@/settings/setup/relay";
import { reportWarning } from "@/shared";
import { openRelayUpdateModal } from "@/ui";

import type { PluginHost } from "./host";

const SKIPPED_KEY = "mdsync-relay-update-skipped";

export interface RelayUpdate {
	/** This device can deploy a newer build over the relay in use. */
	ready(): boolean;
	offer(): Promise<void>;
	subscribe(listener: () => void): () => void;
}

/**
 * Finds an outdated relay this device's Cloudflare token can deploy once its socket connects, and offers the
 * update once per relay per launch; "not now" holds until a newer build ships. A deploy reconnects the
 * socket, so a relay found outdated is checked again on every connect.
 */
export function registerRelayUpdate(plugin: Plugin & PluginHost): RelayUpdate {
	const checked = new Set<string>();
	const listeners = new Set<() => void>();
	/** The relays found outdated, by account and URL, with the secret they answered to. */
	const outdated = new Map<string, RelayTarget>();
	let offering: Promise<void> | null = null;
	const keyOf = (accountId: string, relayUrl: string): string =>
		`${accountId} ${relayUrl}`;
	const notify = (): void => {
		for (const listener of listeners) listener();
	};
	// Read at use: a token forgotten or a relay switched since must not deploy.
	const inUse = () => {
		const { settings } = plugin;
		const login = cloudflareOf(settings);
		if (!login) return null;
		const key = keyOf(login.accountId, settings.relayUrl);
		const target = outdated.get(key);
		// A secret edited since is untested: deploying it would lock the other devices out.
		return target?.secret === settings.relaySecret
			? { key, login, target }
			: null;
	};
	const ask = async (): Promise<void> => {
		const found = inUse();
		if (!found) return;
		if (await openRelayUpdateModal(plugin, found.login, found.target)) {
			outdated.delete(found.key);
			notify();
		} else {
			plugin.app.saveLocalStorage(SKIPPED_KEY, RELAY_VERSION);
		}
	};
	const update: RelayUpdate = {
		ready: () => inUse() !== null,
		// The settings window is its own: its button can ask while the offer is open in the main one.
		offer: () => {
			offering ??= ask().finally(() => {
				offering = null;
			});
			return offering;
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	const check = async (): Promise<void> => {
		const { settings, app } = plugin;
		const login = cloudflareOf(settings);
		if (!login || runningRelayDeploy()) return;
		const { relayUrl, relaySecret } = settings;
		const key = keyOf(login.accountId, relayUrl);
		if (checked.has(key) && !outdated.has(key)) return;
		checked.add(key);
		const status = await testRelay(settings);
		if (!status.ok) return;
		if (!relayBehind(status.version)) {
			if (outdated.delete(key)) notify();
			return;
		}
		// Known already: only the secret the relay just accepted is new.
		const known = outdated.get(key);
		const name =
			known?.name ??
			ownRelayName(await accountRelays(login.api, login.accountId), relayUrl);
		// Deploying a relay switched away from meanwhile would write it back over the new one.
		const stale =
			plugin.unloaded ||
			plugin.settings.relayUrl !== relayUrl ||
			plugin.settings.relaySecret !== relaySecret;
		if (!name || stale) return;
		outdated.set(key, { name, secret: relaySecret });
		notify();
		if (known || app.loadLocalStorage(SKIPPED_KEY) === RELAY_VERSION) return;
		await update.offer();
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
	return update;
}
