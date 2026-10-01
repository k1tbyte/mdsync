import { requestUrl } from "obsidian";

import type { PluginHost } from "@/plugin/host";
import {
	activeStorage,
	isRelayConfigured,
	type RelayConfig,
} from "@/settings/model";
import { errorMessage, relayBase } from "@/shared";
import {
	createStorageAdapter,
	describeStorageTarget,
	isAdapterConfigured,
} from "@/storage";
import { REMOTE_MANIFEST_KEY } from "@/sync/constants";

export interface ConnectionTestResult {
	ok: boolean;
	message: string;
}

/**
 * Reaches the remote without a passphrase, so credentials can be checked before anything is encrypted.
 * Reads only the manifest key: absent is a healthy empty remote, anything else a real connection problem.
 */
export async function testConnection(
	plugin: PluginHost,
): Promise<ConnectionTestResult> {
	const config = activeStorage(plugin.settings);
	if (!isAdapterConfigured(config)) {
		return { ok: false, message: "This backend is not fully configured yet." };
	}
	const target = describeStorageTarget(config);
	try {
		const adapter = createStorageAdapter(config);
		const found = await adapter.exists(REMOTE_MANIFEST_KEY);
		return {
			ok: true,
			message: found
				? `Connected to ${target}. A vault is already published there.`
				: `Connected to ${target}. No vault published yet - your first push will create one.`,
		};
	} catch (err) {
		return {
			ok: false,
			message: `Could not reach ${target}: ${errorMessage(err)}`,
		};
	}
}

/** Tells a wrong URL (unreachable, HTTP 404) apart from a wrong secret. */
export async function testRelay(
	relay: RelayConfig,
): Promise<ConnectionTestResult> {
	if (!isRelayConfigured(relay)) {
		return { ok: false, message: "Enter the relay URL and secret first." };
	}
	try {
		const res = await requestUrl({
			url: `${relayBase(relay.relayUrl)}/status`,
			method: "GET",
			headers: { "X-Obsync-Admin": relay.relaySecret },
			throw: false,
		});
		return res.status === 200
			? { ok: true, message: "Connected. The relay accepts this secret." }
			: { ok: false, message: `Relay error: ${relayMessage(res)}` };
	} catch (err) {
		return { ok: false, message: errorMessage(err) };
	}
}

/**
 * An edge error page is HTML and Obsidian parses `.json` lazily: reading it would throw a SyntaxError over
 * the status the caller needs.
 */
function relayMessage(res: { status: number; json?: unknown }): string {
	try {
		const detail = res.json as { message?: string } | undefined;
		if (detail?.message) return detail.message;
	} catch {
		// Not JSON; the status is the whole story.
	}
	return `HTTP ${res.status}`;
}
