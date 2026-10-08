import { LINK_HEADERS, type LinkStatus } from "@mdsync/protocol";
import { requestUrl } from "obsidian";

import { relayBase } from "@/shared";
import { StorageRequestError } from "@/storage/types";

import { ADMIN_HEADER, type BrokerAdmin } from "./share-broker";
import { errorCode, StorageHttpError } from "./util";

export interface LinkOptions {
	maxViews: number | null;
	/** Unix seconds. */
	expires: number | null;
	/** Passphrase gate and salt (base64url), both or neither. */
	protection: { gate: string; salt: string } | null;
}

/** Creates a link, or with `update` replaces a standing one and keeps its view counter. */
export async function putLink(
	admin: BrokerAdmin,
	id: string,
	sealed: Uint8Array,
	options: LinkOptions,
	update?: boolean,
): Promise<void> {
	const query = new URLSearchParams();
	if (options.maxViews !== null)
		query.set("maxViews", String(options.maxViews));
	if (options.expires !== null) query.set("expires", String(options.expires));
	if (update) query.set("update", "1");
	const headers: Record<string, string> = {
		"Content-Type": "application/octet-stream",
	};
	if (options.protection) {
		headers[LINK_HEADERS.gate] = options.protection.gate;
		headers[LINK_HEADERS.salt] = options.protection.salt;
	}
	const suffix = query.size ? `?${query}` : "";
	await callLink(admin, `/link/${id}${suffix}`, {
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
			refusal =
				"This relay does not support share links yet. Redeploy it with the Deploy Relay workflow.";
		} else if (request.method === "GET") {
			return null;
		} else if (request.method === "PUT") {
			refusal = "This link has ended. Create a new one.";
		}
	} else if (res.status === 401 && code === "unauthorized") {
		refusal = "The relay did not accept its secret. Check the relay settings.";
	} else if (res.status === 413 && code === "too_large") {
		refusal = "This note is too large to share as a link.";
	} else if (res.status === 400 && code === "bad_request") {
		refusal = "The relay refused this link's settings.";
	}
	if (refusal) throw new StorageRequestError(message, refusal);
	throw new StorageHttpError(res.status, message);
}
