import { toHex } from "./bytes";

const encoder = new TextEncoder();

/** A grant admits for a day, so a leaked one expires; a socket it admitted stays open past that. */
export const GRANT_TTL_S = 24 * 60 * 60;

/**
 * `<expiry>.<HMAC-SHA256(relay secret, "<expiry>:<channel>")>`, unix seconds
 * and lowercase hex: opens that channel and no other, until then.
 */
export async function deriveChannelGrant(
	secret: string,
	channel: string,
	expires = Math.floor(Date.now() / 1000) + GRANT_TTL_S,
): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign(
		"HMAC",
		key,
		encoder.encode(`${expires}:${channel}`),
	);
	return `${expires}.${toHex(mac)}`;
}

/** The expiry a grant names; null for a token that is no grant, such as a share token. */
export function grantExpiry(token: string): number | null {
	const match = /^(\d{1,12})\./.exec(token);
	return match ? Number(match[1]) : null;
}
