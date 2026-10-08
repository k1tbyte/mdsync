import { LINK_HEADERS, type LinkStatus } from "@mdsync/protocol";
import { requestUrl } from "obsidian";

import { relayBase } from "@/shared";
import { StorageRequestError } from "@/storage/types";

import { ADMIN_HEADER, type BrokerAdmin } from "./share-broker";
import { errorCode, StorageHttpError } from "./util";

const OUTDATED_RELAY =
	"This relay is out of date for share links. Redeploy it with the Deploy Relay workflow.";

export interface NewLink {
	maxViews: number | null;
	/** Seconds the relay counts on its own clock, so a wrong device clock cannot misdate it; null never expires. */
	ttl: number | null;
	gate: string;
	/** base64url; set exactly when a passphrase protects the link. */
	salt: string | null;
}

/** Unix seconds the relay will end the link at; null never. */
export async function createLink(
	admin: BrokerAdmin,
	id: string,
	sealed: Uint8Array,
	options: NewLink,
): Promise<number | null> {
	const query = new URLSearchParams();
	if (options.maxViews !== null)
		query.set("maxViews", String(options.maxViews));
	if (options.ttl !== null) query.set("ttl", String(options.ttl));
	const stored = (await putSealed(
		admin,
		`/link/${id}${query.size ? `?${query}` : ""}`,
		sealed,
		options,
	)) as { expires?: number | null };
	if (stored.expires === undefined) {
		// An older relay ignores `ttl` and would keep the link for ever.
		await revokeLink(admin, id).catch(() => undefined);
		throw new StorageRequestError(
			"Link broker answered a creation without an expiry",
			OUTDATED_RELAY,
		);
	}
	return stored.expires;
}

/** Replaces a standing link's note and keeps its limits and view counter; the gate must be the link's own. */
export async function replaceLink(
	admin: BrokerAdmin,
	id: string,
	sealed: Uint8Array,
	gate: string,
): Promise<void> {
	await putSealed(admin, `/link/${id}?update=1`, sealed, { gate, salt: null });
}

function putSealed(
	admin: BrokerAdmin,
	path: string,
	sealed: Uint8Array,
	protection: { gate: string; salt: string | null },
): Promise<unknown> {
	const headers: Record<string, string> = {
		"Content-Type": "application/octet-stream",
		[LINK_HEADERS.gate]: protection.gate,
	};
	if (protection.salt) headers[LINK_HEADERS.salt] = protection.salt;
	return callLink(admin, path, {
		method: "PUT",
		headers,
		body: sealed.slice().buffer,
	});
}

/** Null when the link is gone (expired, spent, revoked). */
export async function linkStatus(
	admin: BrokerAdmin,
	id: string,
): Promise<LinkStatus | null> {
	return (await callLink(admin, `/link/${id}/status`, {
		method: "GET",
	})) as LinkStatus | null;
}

export async function revokeLink(
	admin: BrokerAdmin,
	id: string,
): Promise<void> {
	await callLink(admin, `/link/${id}`, { method: "DELETE" });
}

async function callLink(
	admin: BrokerAdmin,
	path: string,
	request: {
		method: "PUT" | "GET" | "DELETE";
		headers?: Record<string, string>;
		body?: ArrayBuffer;
	},
): Promise<unknown> {
	const res = await requestUrl({
		url: `${relayBase(admin.relayUrl)}${path}`,
		method: request.method,
		headers: { [ADMIN_HEADER]: admin.secret, ...request.headers },
		body: request.body,
		throw: false,
	});
	if (res.status >= 200 && res.status < 300) return res.json;
	const code = errorCode(res.text);
	const message = `Link broker ${path} answered HTTP ${res.status}${code ? ` (${code})` : ""}`;
	let refusal: string | undefined;
	if (res.status === 404) {
		if (code !== "gone") {
			refusal = OUTDATED_RELAY;
		} else if (request.method === "GET") {
			return null;
		} else if (request.method === "PUT") {
			refusal = "This link has ended. Create a new one.";
		}
	} else if (res.status === 401 && code === "unauthorized") {
		refusal = "The relay did not accept its secret. Check the relay settings.";
	} else if (res.status === 403 && code === "gate") {
		refusal = "That is not this link's passphrase.";
	} else if (res.status === 413 && code === "too_large") {
		refusal = "This note is too large to share as a link.";
	} else if (res.status === 400 && code === "bad_request") {
		refusal = "The relay refused this link's settings.";
	}
	if (refusal) throw new StorageRequestError(message, refusal);
	throw new StorageHttpError(res.status, message);
}
