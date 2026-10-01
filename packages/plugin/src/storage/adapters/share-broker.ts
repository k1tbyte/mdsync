/**
 * The relay's share broker. A participant never holds storage credentials: the broker presigns each request
 * under their share token and bytes go straight to the owner's bucket. The owner registers where the share
 * lives and issues the tokens.
 */

import { requestUrl } from "obsidian";

import { relayBase } from "@/shared";
import type { S3StorageConfig } from "@/storage/config";
import {
	ShareRefusedError,
	type StorageAdapter,
	StorageRequestError,
} from "@/storage/types";

import {
	endpointUrl,
	type S3Method,
	type S3RequestInput,
	signingRegion,
} from "./s3-signer";
import { createS3Store } from "./s3-store";
import { ShareSignedUrls } from "./share-signed-urls";
import { StorageHttpError } from "./util";

export interface BrokerAccess {
	relayUrl: string;
	token: string;
}

/** The owner's side: the relay and its deployment secret. */
export interface BrokerAdmin {
	relayUrl: string;
	secret: string;
}

const SIGN_OPS: Record<S3Method, string> = {
	GET: "get",
	PUT: "put",
	DELETE: "delete",
	HEAD: "head",
};
const ADMIN_HEADER = "X-Obsync-Admin";
/** Refusals that say something about the share, not the network: never retried. */
const PARTICIPANT_REFUSALS: Record<string, string> = {
	unauthorized: "This shared folder's invite is no longer valid.",
	read_only: "This shared folder is read-only for you.",
	storage_not_registered: "The owner has not connected this shared folder yet.",
};
const ADMIN_REFUSALS: Record<string, string> = {
	unauthorized:
		"The relay did not accept its secret. Check the relay settings.",
	bad_request: "The relay refused this shared folder's storage settings.",
};

export function createBrokerAdapter(
	shareId: string,
	access: BrokerAccess,
): StorageAdapter {
	// Listings come back as full bucket keys under this.
	let base = "";
	const reads = new ShareSignedUrls((keys) => signBatch(access, "get", keys));
	const writes = new ShareSignedUrls((keys) => signBatch(access, "put", keys));
	const store = createS3Store({
		// The share's objects, not the route: a new relay keeps the sync state.
		identity: `broker|${shareId}`,
		key: (key) => key,
		relative: (listed) =>
			listed.startsWith(base) ? listed.slice(base.length) : listed,
		sign: async (input) => {
			const urls = input.method === "PUT" ? writes : reads;
			if (
				(input.method === "GET" || input.method === "PUT") &&
				input.key !== ""
			) {
				const url = await urls.take(input.key);
				if (url) return { url, headers: input.headers ?? {} };
			}
			const signed = await callBroker(
				access.relayUrl,
				"/share/sign",
				{
					method: "POST",
					headers: bearer(access),
					body: signRequest(input),
				},
				PARTICIPANT_REFUSALS,
			);
			if (typeof signed.base === "string") base = signed.base;
			return { url: String(signed.url), headers: input.headers ?? {} };
		},
	});
	return {
		...store,
		prepareReads: (keys) => reads.expect(keys),
		prepareWrites: (keys) => writes.expect(keys),
	};
}

/** Where the broker signs for this share, with this device's credentials. */
export async function registerShareStorage(
	admin: BrokerAdmin,
	shareId: string,
	s3: S3StorageConfig,
): Promise<void> {
	const { bucket, prefix, accessKeyId, secretAccessKey, forcePathStyle } = s3;
	await callBroker(
		admin.relayUrl,
		`/share/shares/${shareId}`,
		{
			method: "PUT",
			headers: { [ADMIN_HEADER]: admin.secret },
			body: {
				endpoint: endpointUrl(s3),
				region: signingRegion(s3),
				bucket,
				prefix,
				accessKeyId,
				secretAccessKey,
				forcePathStyle,
			},
		},
		ADMIN_REFUSALS,
	);
}

/** A token for one person; issuing again for them revokes their previous one. */
export async function issueShareToken(
	admin: BrokerAdmin,
	grant: {
		shareId: string;
		participantId: string;
		label: string;
		readOnly: boolean;
	},
): Promise<string> {
	const { shareId, participantId, label, readOnly } = grant;
	const issued = await callBroker(
		admin.relayUrl,
		"/share/tokens",
		{
			method: "POST",
			headers: { [ADMIN_HEADER]: admin.secret },
			body: { shareId, participantId, label, role: readOnly ? "ro" : "rw" },
		},
		ADMIN_REFUSALS,
	);
	return String(issued.token);
}

/** Revokes every participant's token; the share's objects stay in the owner's bucket. */
export async function endShare(
	admin: BrokerAdmin,
	shareId: string,
): Promise<void> {
	await callBroker(
		admin.relayUrl,
		`/share/shares/${shareId}`,
		{ method: "DELETE", headers: { [ADMIN_HEADER]: admin.secret } },
		ADMIN_REFUSALS,
	);
}

export interface Participant {
	id: string;
	/** The name the owner invited them under. */
	label: string;
	readOnly: boolean;
}

/** Everyone holding a live token for the share: the broker is where access lives. */
export async function listParticipants(
	admin: BrokerAdmin,
	shareId: string,
): Promise<Participant[]> {
	const listed = await callBroker(
		admin.relayUrl,
		`/share/tokens?shareId=${encodeURIComponent(shareId)}`,
		{ method: "GET", headers: { [ADMIN_HEADER]: admin.secret } },
		ADMIN_REFUSALS,
	);
	const participants = Array.isArray(listed.participants)
		? (listed.participants as Record<string, unknown>[])
		: [];
	return participants.map((each) => ({
		id: String(each.participantId),
		label: typeof each.label === "string" ? each.label : "",
		readOnly: each.role === "ro",
	}));
}

/** Their token dies at the broker and their hub channel is cut. */
export async function revokeParticipant(
	admin: BrokerAdmin,
	shareId: string,
	participantId: string,
): Promise<void> {
	await callBroker(
		admin.relayUrl,
		`/share/tokens/${encodeURIComponent(participantId)}?shareId=${encodeURIComponent(shareId)}`,
		{ method: "DELETE", headers: { [ADMIN_HEADER]: admin.secret } },
		ADMIN_REFUSALS,
	);
}

/** The participant's side of leaving: their own token dies, whoever invited them. */
export async function leaveShare(access: BrokerAccess): Promise<void> {
	await callBroker(
		access.relayUrl,
		"/share/token",
		{ method: "DELETE", headers: bearer(access) },
		PARTICIPANT_REFUSALS,
	);
}

function bearer(access: BrokerAccess): Record<string, string> {
	return { Authorization: `Bearer ${access.token}` };
}

async function signBatch(
	access: BrokerAccess,
	op: "get" | "put",
	keys: string[],
): Promise<string[]> {
	const { urls } = await callBroker(
		access.relayUrl,
		"/share/sign",
		{
			method: "POST",
			headers: bearer(access),
			body: { op, keys },
		},
		PARTICIPANT_REFUSALS,
	);
	if (
		!Array.isArray(urls) ||
		urls.length !== keys.length ||
		!urls.every((url) => typeof url === "string")
	) {
		throw new Error(
			"Share broker answered a signing batch that does not fit it",
		);
	}
	return urls;
}

function signRequest(input: S3RequestInput): Record<string, unknown> {
	if (input.key !== "") return { op: SIGN_OPS[input.method], key: input.key };
	const query = input.query ?? {};
	const maxKeys = query["max-keys"];
	return {
		op: "list",
		prefix: query.prefix,
		cursor: query["continuation-token"],
		maxKeys: maxKeys ? Number(maxKeys) : undefined,
	};
}

async function callBroker(
	relayUrl: string,
	path: string,
	request: {
		method: string;
		headers: Record<string, string>;
		body?: Record<string, unknown>;
	},
	refusals: Record<string, string>,
): Promise<Record<string, unknown>> {
	const res = await requestUrl({
		url: `${relayBase(relayUrl)}${path}`,
		method: request.method,
		headers: request.body
			? { ...request.headers, "Content-Type": "application/json" }
			: request.headers,
		body: request.body && JSON.stringify(request.body),
		throw: false,
	});
	if (res.status >= 200 && res.status < 300) return res.json;
	const code = errorCode(res.text);
	const refusal = code ? refusals[code] : undefined;
	const message = `Share broker ${path} answered HTTP ${res.status}${code ? ` (${code})` : ""}`;
	if (refusal && code === "unauthorized" && refusals === PARTICIPANT_REFUSALS) {
		throw new ShareRefusedError(message, refusal);
	}
	if (refusal) throw new StorageRequestError(message, refusal);
	throw new StorageHttpError(res.status, message);
}

function errorCode(text: string): string | null {
	try {
		const parsed: unknown = JSON.parse(text);
		const code = (parsed as { error?: unknown } | null)?.error;
		return typeof code === "string" ? code : null;
	} catch {
		return null;
	}
}
