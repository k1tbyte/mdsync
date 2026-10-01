/**
 * The broker's KV records: a token per participant, a pointer to each
 * participant's current token, and each share's registered storage. The key
 * layout stays in this file.
 */

import { type HubEnv, hubStub } from "../hub/stub";
import { fingerprint, type SecretEnv } from "../secret";
import type { S3Target } from "./sigv4";

export interface ShareEnv extends Cloudflare.Env, SecretEnv, HubEnv {
	SHARE_TOKENS: KVNamespace;
}

export const EShareRole = {
	ReadWrite: "rw",
	ReadOnly: "ro",
} as const;
export type EShareRole = (typeof EShareRole)[keyof typeof EShareRole];

export interface TokenRecord {
	shareId: string;
	participantId: string;
	role: EShareRole;
	label?: string;
	createdAt: number;
}

/** `prefix` is the base prefix; key.ts appends `shares/<shareId>/`. */
export type ShareStorage = S3Target & { prefix: string };

const TOKEN_BYTES = 32;
/** TOKEN_BYTES as unpadded base64url; anything else cannot be a token, so KV is never asked. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const tokenKey = (token: string) => `tok:${token}`;
const storageKey = (shareId: string) => `storage:${shareId}`;
const pointerKey = (shareId: string, participantId: string) =>
	`pt:${shareId}:${participantId}`;

/**
 * Whose live token this is and for which share; null once it is revoked or
 * replaced. Current means the participant's pointer names it: two re-invites
 * at once each drop the same predecessor, and the token whose pointer lost
 * would otherwise live on where no revoke finds it.
 */
export async function shareGrantOf(
	env: ShareEnv,
	token: string,
): Promise<TokenRecord | null> {
	if (!TOKEN_PATTERN.test(token)) return null;
	const record = await tokenRecord(env, token);
	if (!record) return null;
	const pointer = pointerKey(record.shareId, record.participantId);
	return (await env.SHARE_TOKENS.get(pointer)) === token ? record : null;
}

async function tokenRecord(
	env: ShareEnv,
	token: string,
): Promise<TokenRecord | null> {
	return (await env.SHARE_TOKENS.get(
		tokenKey(token),
		"json",
	)) as TokenRecord | null;
}

export async function readStorage(
	env: ShareEnv,
	shareId: string,
): Promise<ShareStorage | null> {
	return (await env.SHARE_TOKENS.get(
		storageKey(shareId),
		"json",
	)) as ShareStorage | null;
}

/** The plugin re-registers on every start, and KV's free tier allows 1k writes a day. */
export async function saveStorage(
	env: ShareEnv,
	shareId: string,
	storage: ShareStorage,
): Promise<void> {
	const key = storageKey(shareId);
	const next = JSON.stringify(storage);
	if ((await env.SHARE_TOKENS.get(key)) === next) return;
	await env.SHARE_TOKENS.put(key, next);
}

export async function saveToken(
	env: ShareEnv,
	grant: Omit<TokenRecord, "createdAt">,
): Promise<TokenRecord & { token: string }> {
	const token = base64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
	const record: TokenRecord = { ...grant, createdAt: Date.now() };
	const pointer = pointerKey(record.shareId, record.participantId);
	const previous = await env.SHARE_TOKENS.get(pointer);
	if (previous) await dropToken(env, previous);
	await env.SHARE_TOKENS.put(tokenKey(token), JSON.stringify(record));
	await env.SHARE_TOKENS.put(pointer, token);
	return { token, ...record };
}

export async function listParticipants(env: ShareEnv, shareId: string) {
	const listed = await Promise.all(
		(await participantIds(env, shareId)).map(async (participantId) => {
			const token = await env.SHARE_TOKENS.get(
				pointerKey(shareId, participantId),
			);
			// The pointer names it, so it is current: no second pointer read.
			const record = token ? await tokenRecord(env, token) : null;
			return (
				record && {
					participantId,
					label: record.label ?? "",
					role: record.role,
				}
			);
		}),
	);
	// KV's list lags a revoke by up to a minute; the pointer read does not.
	return listed.filter((each) => each !== null);
}

/** A participant leaving revokes the token they hold, never one issued after it. */
export async function revokeHeldToken(
	env: ShareEnv,
	token: string,
	record: TokenRecord,
): Promise<void> {
	await dropToken(env, token);
	const pointer = pointerKey(record.shareId, record.participantId);
	if ((await env.SHARE_TOKENS.get(pointer)) === token) {
		await env.SHARE_TOKENS.delete(pointer);
	}
}

export async function revokeParticipant(
	env: ShareEnv,
	shareId: string,
	participantId: string,
): Promise<boolean> {
	const pointer = pointerKey(shareId, participantId);
	const token = await env.SHARE_TOKENS.get(pointer);
	if (!token) return false;
	await dropToken(env, token);
	await env.SHARE_TOKENS.delete(pointer);
	return true;
}

/** Revokes before forgetting the storage, so no token outlives the share. */
export async function revokeShare(
	env: ShareEnv,
	shareId: string,
): Promise<number> {
	let revoked = 0;
	for (const participantId of await participantIds(env, shareId)) {
		if (await revokeParticipant(env, shareId, participantId)) revoked++;
	}
	await env.SHARE_TOKENS.delete(storageKey(shareId));
	return revoked;
}

async function participantIds(
	env: ShareEnv,
	shareId: string,
): Promise<string[]> {
	const prefix = pointerKey(shareId, "");
	const ids: string[] = [];
	let cursor: string | undefined;
	// KV lists max 1000 keys per call; must paginate to avoid silent truncation.
	do {
		const listed = await env.SHARE_TOKENS.list({ prefix, cursor });
		for (const entry of listed.keys) ids.push(entry.name.slice(prefix.length));
		cursor = listed.list_complete ? undefined : listed.cursor;
	} while (cursor);
	return ids;
}

/** Cuts the hub sockets first: a retry after a failure still finds the pointer and cuts again. */
async function dropToken(env: ShareEnv, token: string): Promise<void> {
	await hubStub(env).dropGrant(await fingerprint(token));
	await env.SHARE_TOKENS.delete(tokenKey(token));
}

function base64Url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}
