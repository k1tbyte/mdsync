/** What the plugin will do against a relay's link routes, for the link scenarios. */

import {
	deriveLinkKeys,
	linkUrl,
	newLinkId,
	newLinkKey,
	newLinkSalt,
	sealLinkPayload,
	toBase64Url,
} from "@mdsync/protocol";

export const SECRET = "e2e-secret";

export function admin(
	base: string,
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	return fetch(`${base}${path}`, {
		...init,
		headers: { ...init.headers, "X-Mdsync-Admin": SECRET },
	});
}

export function put(
	base: string,
	id: string,
	body: Uint8Array<ArrayBuffer>,
	query = "",
	headers: Record<string, string> = {},
): Promise<Response> {
	return admin(base, `/link/${id}${query}`, { method: "PUT", headers, body });
}

export function open(
	base: string,
	id: string,
	gate?: string,
): Promise<Response> {
	return fetch(`${base}/link/${id}/open`, {
		method: "POST",
		body: gate === undefined ? undefined : JSON.stringify({ gate }),
	});
}

export interface Published {
	id: string;
	/** What the owner sends: the page and the key after the `#`. */
	url: string;
}

/** Seals a note and stores it, as the plugin's share action will. */
export async function publish(
	base: string,
	note: { title: string; html: string },
	options: { passphrase?: string; maxViews?: number } = {},
): Promise<Published> {
	const id = newLinkId();
	const key = newLinkKey();
	const salt = newLinkSalt();
	const keys = await deriveLinkKeys(
		key,
		options.passphrase ? { passphrase: options.passphrase, salt } : undefined,
	);
	const sealed = await sealLinkPayload(
		id,
		{ ...note, createdAt: Date.now() },
		keys.content,
	);
	const query = options.maxViews ? `?maxViews=${options.maxViews}` : "";
	const headers: Record<string, string> = { "X-Mdsync-Gate": keys.gate };
	if (options.passphrase) headers["X-Mdsync-Salt"] = toBase64Url(salt);
	const stored = await put(base, id, sealed, query, headers);
	if (!stored.ok) throw new Error(`could not store the link: ${stored.status}`);
	return { id, url: linkUrl(base, id, key) };
}
