import { requestUrl } from "obsidian";

import { isRelayConfigured, type RelayConfig } from "@/settings/model";

/** Resolves when the URL reaches a relay that accepts the secret. */
export async function checkRelay(relay: RelayConfig): Promise<void> {
	if (!isRelayConfigured(relay)) {
		throw new Error(
			"Set the relay server URL and secret under Settings → Obsync → Connection.",
		);
	}
	const res = await requestUrl({
		url: `${relay.relayUrl.trim().replace(/\/+$/, "")}/status`,
		method: "GET",
		headers: { "X-Obsync-Admin": relay.relaySecret },
		throw: false,
	});
	if (res.status !== 200) throw new Error(`Relay error: ${relayMessage(res)}`);
}

/** An edge error page is HTML, and Obsidian parses `.json` lazily: reading it
 * would throw a SyntaxError over the status the caller actually needs. */
function relayMessage(res: { status: number; json?: unknown }): string {
	try {
		const detail = res.json as { message?: string } | undefined;
		if (detail?.message) return detail.message;
	} catch {
		// Not JSON; the status is the whole story.
	}
	return `HTTP ${res.status}`;
}
