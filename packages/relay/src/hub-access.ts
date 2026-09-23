/**
 * Admission to the hub, decided in the stateless worker before the Durable
 * Object wakes, so a request with no valid grant costs the hub nothing.
 */

import {
	deriveChannelGrant,
	EHubParam,
	HUB_PATH,
	HUB_SIGNAL_PATH,
	UNAUTHORIZED_CLOSE_CODE,
} from "@obsync/protocol";
import { type Admission, HUB_ADMISSION_HEADER, hubStub } from "./hub";
import type { Grant } from "./hub-peer";
import { fingerprint, relaySecret, secretsEqual } from "./secret";
import { type ShareEnv, shareGrantOf, shareRoomId } from "./share";

/** Room tokens are 64 hex chars and share tokens 43; KV rejects keys over 512 bytes. */
const MAX_TOKEN_LENGTH = 128;
const MAX_CHANNEL_LENGTH = 128;
const MAX_SLOTS = 32;
const MAX_DEVICE_LENGTH = 64;
/** `who` of a socket admitted by the deployment secret itself. */
export const OWNER = "owner";

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
	forwarded.headers.set(HUB_ADMISSION_HEADER, JSON.stringify(admission));
	return hubStub(env).fetch(forwarded);
}

/**
 * A grant is the channel's HMAC under the deployment secret, or a live share
 * token of that channel's share. Anything else admits nothing.
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
	if (await secretsEqual(token, await deriveChannelGrant(secret, channel))) {
		return { channel, grant: await fingerprint(token), who: OWNER };
	}
	const share = await shareGrantOf(env, token);
	if (!share || shareRoomId(share.shareId) !== channel) return null;
	return { channel, grant: await fingerprint(token), who: share.participantId };
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

/** The cold-sync ping from a device whose socket is down. */
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
	if (!(await grantFor(env, channel, token))) {
		return new Response("Unauthorized", { status: 401 });
	}
	await hubStub(env).signal(channel, deviceOf(url.searchParams));
	return new Response("ok");
}

function deviceOf(params: URLSearchParams): string {
	return (params.get(EHubParam.Device) ?? "")
		.trim()
		.slice(0, MAX_DEVICE_LENGTH);
}

/** A socket must be accepted to carry a close code; a plain 401 would look like a network error. */
function unauthorized(request: Request): Response {
	if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
		return new Response("Unauthorized", { status: 401 });
	}
	const { 0: client, 1: server } = new WebSocketPair();
	server.accept();
	server.close(UNAUTHORIZED_CLOSE_CODE, "Unauthorized");
	return new Response(null, { status: 101, webSocket: client });
}
