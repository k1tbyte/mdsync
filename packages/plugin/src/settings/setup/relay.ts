import bundle from "mdsync:relay-bundle";
import { toHex } from "@mdsync/protocol";

import {
	type AccountRelays,
	deployRelay,
	type ERelayDeployStep,
	ownRelayName,
	RELAY_NAME,
	RELAY_VERSION,
	type RelayTarget,
} from "@/cloudflare";
import { randomBytes, randomSecret } from "@/crypto";
import type { PluginHost } from "@/plugin/host";
import type { CloudflareLogin } from "@/settings/cloudflare-login";
import { testRelay } from "@/settings/connection-test";
import { isRelayConfigured, type RelayConfig } from "@/settings/model";

const POLL_MS = 3000;
/** A workers.dev name registered just now can take minutes to answer. */
const WAIT_MS = 3 * 60_000;

/** Deploy now, or ask the user: `ask` is the worker to update with a typed secret, null when this device's relay is not on the account. */
export type RelayPlan = { deploy: RelayTarget } | { ask: string | null };

/**
 * Updates this device's relay when it can; replacing a relay, or one whose secret is unknown, is asked.
 * `failed` is the deploy that just broke off: its secret is this device's own, so it goes again unasked.
 * A silent relay alone proves nothing: another device may have changed its secret.
 */
export async function planRelay(
	relays: AccountRelays,
	settings: RelayConfig,
	failed: RelayTarget | null = null,
): Promise<RelayPlan> {
	if (failed) return { deploy: failed };
	const own = ownRelayName(relays, settings.relayUrl);
	const configured = isRelayConfigured(settings);
	if (own && configured && (await testRelay(settings)).ok) {
		return { deploy: { name: own, secret: settings.relaySecret } };
	}
	if (!own && !configured && !relays.taken.includes(RELAY_NAME)) {
		return { deploy: { name: RELAY_NAME, secret: randomSecret() } };
	}
	return { ask: own ?? (configured ? null : RELAY_NAME) };
}

let deploying: Promise<void> | null = null;
/** Cloudflare may hold the secret of a deploy whose answer was lost: a reopened wizard must retry with it. */
let failed: { accountId: string; target: RelayTarget } | null = null;

/** The deploy still running from a wizard that may be closed by now. */
export function runningRelayDeploy(): Promise<void> | null {
	return deploying;
}

/** The last deploy on this account that broke off, for planRelay's `failed`. */
export function failedRelay(accountId: string): RelayTarget | null {
	return failed?.accountId === accountId ? failed.target : null;
}

/**
 * The URL and secret are saved the moment the worker holds the secret, so closing the wizard mid-deploy
 * never loses the secret of a live relay.
 */
export function deployOwnRelay(
	plugin: PluginHost,
	login: CloudflareLogin,
	target: RelayTarget,
	onStep: (step: ERelayDeployStep) => void,
): Promise<void> {
	// Outlives the wizard that started it, so a reopened one could start a second beside it.
	if (deploying)
		return Promise.reject(
			new Error("The relay is still deploying. Wait a moment."),
		);
	const run = (async () => {
		try {
			await deployTo(plugin, login, target, onStep);
			failed = null;
		} catch (err) {
			failed = { accountId: login.accountId, target };
			throw err;
		} finally {
			deploying = null;
		}
	})();
	deploying = run;
	return run;
}

async function deployTo(
	plugin: PluginHost,
	login: CloudflareLogin,
	target: RelayTarget,
	onStep: (step: ERelayDeployStep) => void,
): Promise<void> {
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

let activating: Promise<boolean> | null = null;

/** One wait however many wizards ask: the relay is switched on once, when it answers. Survives a closed wizard, stops on unload. */
export function activateRelay(plugin: PluginHost): Promise<boolean> {
	activating ??= (async () => {
		try {
			const answered = await waitForRelay(
				plugin.settings,
				() => !plugin.unloaded,
			);
			if (answered) await useRelay(plugin);
			return answered;
		} finally {
			activating = null;
		}
	})();
	return activating;
}

/** Real-time sync is what a relay is for: on once it answers. */
export async function useRelay(plugin: PluginHost): Promise<void> {
	plugin.settings.realtimeSync = true;
	await plugin.saveSettings();
	plugin.realtime.hub.restart();
}
