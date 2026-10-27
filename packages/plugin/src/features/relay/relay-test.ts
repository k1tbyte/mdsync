import { requestUrl } from "obsidian";

import {
	type CheckResult,
	isRelayConfigured,
	type RelayConfig,
} from "@/core/settings";
import { errorMessage, isCleartextRemote, relayBase } from "@/core/shared";

export interface RelayTestResult extends CheckResult {
	/** The build the relay runs; null for one deployed outside MDSync. */
	version?: string | null;
}

/** Tells a wrong URL (unreachable, HTTP 404) apart from a wrong secret. */
export async function testRelay(relay: RelayConfig): Promise<RelayTestResult> {
	if (isCleartextRemote(relay.relayUrl)) {
		return {
			ok: false,
			message:
				"Use an https:// relay URL: the secret is sent with every request.",
		};
	}
	if (!isRelayConfigured(relay)) {
		return { ok: false, message: "Enter the relay URL and secret first." };
	}
	try {
		const res = await requestUrl({
			url: `${relayBase(relay.relayUrl)}/status`,
			method: "GET",
			headers: { "X-Mdsync-Admin": relay.relaySecret },
			throw: false,
		});
		const body = jsonOf(res) as {
			message?: string;
			version?: string | null;
		} | null;
		return res.status === 200
			? {
					ok: true,
					message: "Connected. The relay accepts this secret.",
					version: body?.version ?? null,
				}
			: {
					ok: false,
					message: `Relay error: ${body?.message ?? `HTTP ${res.status}`}`,
				};
	} catch (err) {
		return { ok: false, message: errorMessage(err) };
	}
}

/**
 * An edge error page is HTML and Obsidian parses `.json` lazily: reading it would throw a SyntaxError over
 * the status the caller needs.
 */
function jsonOf(res: { json?: unknown }): unknown {
	try {
		return res.json ?? null;
	} catch {
		return null;
	}
}
