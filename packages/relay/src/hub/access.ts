/**
 * Admission to the hub, decided in the stateless worker before the Durable
 * Object wakes, so a request with no valid grant costs the hub nothing.
 */

import {
	deriveChannelGrant,
	EHubParam,
	GRANT_TTL_S,
	grantExpiry,
	HUB_PATH,
	HUB_SIGNAL_PATH,
	MAX_SLOTS,
	OWNER,
	shareChannel,
} from "@obsync/protocol";
import { fingerprint, relaySecret, secretsEqual } from "../secret";
import { EShareRole, type ShareEnv, shareGrantOf } from "../share/kv";
import { type Admission, HUB_ADMISSION_HEADER } from "./durable-object";
import type { Grant } from "./peer";
import { hubStub, unauthorizedSocket } from "./stub";

/** Owner grants are 75 chars and share tokens 43; KV rejects keys over 512 bytes. */
const MAX_TOKEN_LENGTH = 128;
const MAX_CHANNEL_LENGTH = 128;
const MAX_DEVICE_LENGTH = 64;
/** In UTF-16 units, so the UTF-8 of it fits a frame's one-byte text length. */
const MAX_NAME_LENGTH = 64;
const CLOCK_SKEW_S = 24 * 60 * 60;

/** Returns null when the path is not a hub route, so index.ts can fall through. */
export async function handleHubRequest(
	request: Request,
	env: ShareEnv,
	url: URL,
): Promise<Response | null> {
	if (url.pathname === HUB_SIGNAL_PATH) return signal(request, env, url);
	if (url.pathname !== HUB_PATH) return null;

	const admission = await admit(env, url.searchParams);
	if (!admission.slots.some((slot) => slot !== null)) {
		return unauthorized(request);
	}
	const forwarded = new Request(request);
	forwarded.headers.set(HUB_ADMISSION_HEADER, asciiJson(admission));
	return hubStub(env).fetch(forwarded);
}

/** A header value is a byte string: `\u` escapes keep a name's UTF-8 out of it. */
function asciiJson(value: unknown): string {
	return JSON.stringify(value).replace(
		/[^\x20-\x7e]/g,
		(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

/**
 * A grant is the channel's unexpired HMAC under the deployment secret, or a
 * live share token of that channel's share. Anything else admits nothing.
 */
export async function grantFor(
	env: ShareEnv,
	channel: string,
	token: string,
): Promise<Grant | null> {
	// Fail closed: a relay reachable without a secret would leak presence to anyone.
	const secret = relaySecret(env);
	if (!secret || !token || token.length > MAX_TOKEN_LENGTH) return null;
	if (!channel || channel.length > MAX_CHANNEL_LENGTH) return null;
	if (await isOwnerGrant(secret, channel, token)) {
		return { channel, grant: await fingerprint(token), who: OWNER };
	}
	const share = await shareGrantOf(env, token);
	if (!share || shareChannel(share.shareId) !== channel) return null;
	return {
		channel,
		grant: await fingerprint(token),
		who: share.participantId,
		...(share.role === EShareRole.ReadOnly ? { readOnly: true } : {}),
		...(share.label ? { name: share.label.slice(0, MAX_NAME_LENGTH) } : {}),
	};
}

/** Unexpired, and not minted further ahead than a skewed device clock would. */
async function isOwnerGrant(
	secret: string,
	channel: string,
	token: string,
): Promise<boolean> {
	const expires = grantExpiry(token);
	const now = Date.now() / 1000;
	if (expires === null || expires <= now) return false;
	if (expires > now + GRANT_TTL_S + CLOCK_SKEW_S) return false;
	return secretsEqual(
		token,
		await deriveChannelGrant(secret, channel, expires),
	);
}

async function admit(
	env: ShareEnv,
	params: URLSearchParams,
): Promise<Admission> {
	const channels = params.getAll(EHubParam.Channel).slice(0, MAX_SLOTS);
	const tokens = params.getAll(EHubParam.Token);
	const slots = await Promise.all(
		channels.map((channel, slot) =>
			// A channel asked for twice would be announced twice; only its first slot counts.
			channels.indexOf(channel) === slot
				? grantFor(env, channel, tokens[slot] ?? "")
				: null,
		),
	);
	return { device: deviceOf(params), slots };
}

async function signal(
	request: Request,
	env: ShareEnv,
	url: URL,
): Promise<Response> {
	if (request.method !== "POST") {
		return new Response("Method not allowed", { status: 405 });
	}
	const channel = url.searchParams.get(EHubParam.Channel) ?? "";
	const token = url.searchParams.get(EHubParam.Token) ?? "";
	const grant = await grantFor(env, channel, token);
	if (!grant) return new Response("Unauthorized", { status: 401 });
	// A read-only participant never pushes: its signal would only wake everyone.
	if (grant.readOnly) return new Response("Forbidden", { status: 403 });
	await hubStub(env).signal(channel, deviceOf(url.searchParams));
	return new Response("ok");
}

function deviceOf(params: URLSearchParams): string {
	return (params.get(EHubParam.Device) ?? "")
		.trim()
		.slice(0, MAX_DEVICE_LENGTH);
}

function unauthorized(request: Request): Response {
	if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
		return new Response("Unauthorized", { status: 401 });
	}
	return unauthorizedSocket();
}
