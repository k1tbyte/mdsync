/** The one deployment secret: admin auth for shares and the root of every hub channel grant. */

import { toHex } from "@mdsync/protocol";

export const ADMIN_HEADER = "X-Mdsync-Admin";

export interface SecretEnv {
	RELAY_SECRET?: string;
}

const encoder = new TextEncoder();

/** Empty when unset; every caller must then fail closed. */
export function relaySecret(env: SecretEnv): string {
	return (env.RELAY_SECRET ?? "").trim();
}

export async function isAdmin(
	request: Request,
	env: SecretEnv,
): Promise<boolean> {
	const secret = relaySecret(env);
	if (!secret) return false;
	return secretsEqual(request.headers.get(ADMIN_HEADER) ?? "", secret);
}

/** Compares digests, so neither the secret's content nor its length leaks through timing. */
export async function secretsEqual(
	left: string,
	right: string,
): Promise<boolean> {
	const [a, b] = await Promise.all([digest(left), digest(right)]);
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a[i] ^ b[i];
	}
	return diff === 0;
}

/** Lets the hub remember which token opened a channel without holding the token. */
export async function fingerprint(value: string): Promise<string> {
	return toHex(await digest(value));
}

async function digest(value: string): Promise<Uint8Array> {
	return new Uint8Array(
		await crypto.subtle.digest("SHA-256", encoder.encode(value)),
	);
}
