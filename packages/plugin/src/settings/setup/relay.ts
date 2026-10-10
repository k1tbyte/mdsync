import bundle from "mdsync:relay-bundle";
import { toHex } from "@mdsync/protocol";

import {
	deployRelay,
	type ERelayDeployStep,
	workerNames,
	workersSubdomain,
	workerUrl,
} from "@/cloudflare";
import { randomBytes } from "@/crypto";
import type { PluginHost } from "@/plugin/host";
import type { CloudflareLogin } from "@/settings/cloudflare-login";
import { testRelay } from "@/settings/connection-test";
import type { RelayConfig } from "@/settings/model";

/** The relay build this plugin carries; `/status` of a relay running it says the same. */
export const RELAY_VERSION = bundle.version;
export const RELAY_NAME = bundle.name;

const POLL_MS = 3000;
/** A workers.dev name registered just now can take minutes to answer. */
const WAIT_MS = 3 * 60_000;
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface AccountRelays {
	/** Every worker on the account, relay or not: a new relay must not take one's name. */
	taken: readonly string[];
	subdomain: string | null;
}

export async function accountRelays(
	login: CloudflareLogin,
): Promise<AccountRelays> {
	const [taken, subdomain] = await Promise.all([
		workerNames(login.api, login.accountId),
		workersSubdomain(login.api, login.accountId),
	]);
	return { taken, subdomain };
}

/** Where a relay of this name answers, once the account has a workers.dev name. */
export function relayUrlOf(
	relays: AccountRelays,
	name = RELAY_NAME,
): string | null {
	return relays.subdomain ? workerUrl(name, relays.subdomain) : null;
}

/** The worker behind `relayUrl` when it is one of this account's: the relay to update in place. */
export function ownRelayName(
	relays: AccountRelays,
	relayUrl: string,
): string | null {
	if (!relays.subdomain) return null;
	const suffix = `.${relays.subdomain}.workers.dev`;
	const host = hostOf(relayUrl);
	if (!host?.endsWith(suffix)) return null;
	const name = host.slice(0, -suffix.length);
	return relays.taken.includes(name) ? name : null;
}

function hostOf(url: string): string | null {
	try {
		return new URL(url).hostname;
	} catch {
		return null;
	}
}

export function freeRelayName(taken: readonly string[]): string {
	if (!taken.includes(RELAY_NAME)) return RELAY_NAME;
	for (let n = 2; ; n++) {
		const name = `${RELAY_NAME}-${n}`;
		if (!taken.includes(name)) return name;
	}
}

/** Why `name` cannot be a new worker, or null. */
export function relayNameError(
	name: string,
	taken: readonly string[],
): string | null {
	if (!NAME.test(name)) {
		return "Use lowercase letters, digits and dashes, up to 63.";
	}
	return taken.includes(name)
		? "A worker with this name already exists."
		: null;
}

export interface RelayTarget {
	name: string;
	/** The relay's current secret when updating it: shares, links and devices keep working. */
	secret: string;
}

let deploying = false;

/**
 * The URL and secret are saved the moment the worker holds the secret, so closing the wizard mid-deploy
 * never loses the secret of a live relay.
 */
export async function deployOwnRelay(
	plugin: PluginHost,
	login: CloudflareLogin,
	target: RelayTarget,
	onStep: (step: ERelayDeployStep) => void,
): Promise<void> {
	// Outlives the wizard that started it, so a reopened one could start a second beside it.
	if (deploying)
		throw new Error("The relay is still deploying. Wait a moment.");
	deploying = true;
	try {
		await deployRelay({
			api: login.api,
			accountId: login.accountId,
			bundle: { ...bundle, name: target.name },
			secret: target.secret,
			proposeSubdomain: () => `mdsync-${toHex(randomBytes(3))}`,
			onStep,
			onUploaded: async (url) => {
				Object.assign(plugin.settings, {
					relayUrl: url,
					relaySecret: target.secret,
				});
				await plugin.saveSettings();
			},
		});
	} finally {
		deploying = false;
	}
}

/** True once the relay answers with this plugin's build; false when it is still silent after a few minutes, or `keepWaiting` says stop. */
export async function waitForRelay(
	relay: RelayConfig,
	keepWaiting: () => boolean,
): Promise<boolean> {
	const deadline = Date.now() + WAIT_MS;
	while (keepWaiting()) {
		const status = await testRelay(relay);
		if (status.ok && status.version === RELAY_VERSION) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
	}
	return false;
}

/** Real-time sync is what a relay is for: on once it answers. */
export async function useRelay(plugin: PluginHost): Promise<void> {
	plugin.settings.realtimeSync = true;
	await plugin.saveSettings();
	plugin.realtime.hub.restart();
}
