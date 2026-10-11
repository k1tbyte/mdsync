import bundle from "mdsync:relay-bundle";

import type { CloudflareApi } from "./api";
import { workerNames, workersSubdomain, workerUrl } from "./relay-deploy";

/** The relay build this plugin carries; `/status` of a relay running it says the same. */
export const RELAY_VERSION = bundle.version;
export const RELAY_NAME = bundle.name;

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface AccountRelays {
	/** Every worker on the account, relay or not: a new relay must not take one's name. */
	taken: readonly string[];
	subdomain: string | null;
}

export async function accountRelays(
	api: CloudflareApi,
	accountId: string,
): Promise<AccountRelays> {
	const [taken, subdomain] = await Promise.all([
		workerNames(api, accountId),
		workersSubdomain(api, accountId),
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
